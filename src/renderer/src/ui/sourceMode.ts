import type { Editor } from '@milkdown/kit/core';

import { setMarkdown } from '../editor/actions';
import type { FileService } from '../services/fileService';
import { insertTextViaInputEvent } from '../util/inputEvent';
import {
  anchorToSourceCaret,
  captureEditorAnchor,
  lineAt,
  placeEditorCursor,
  placeSourceCaret,
  sourceLines,
  type EditorAnchor,
  type SourceExitAnchor
} from './positionSync';
import { applySourceHighlight, clearSourceHighlight } from './sourceHighlight';

/* ============================================================
 * 源代码 / 渲染视图切换控制器
 * 使用 contenteditable div 支持 CSS Custom Highlight API
 * （语法高亮：sourceHighlight.ts 用 lowlight 分词 → CSS.highlights）
 * ============================================================ */

/** 高亮重建防抖（编辑输入阈值） */
const HIGHLIGHT_DEBOUNCE_MS = 120;

export interface SourceStateSnapshot {
  text: string;
  pos: number;
}

export class SourceModeController {
  private active = false;
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;

  /** 渲染→源码切换时记录的渲染侧锚点（切换后定位用） */
  private pendingEditorAnchor: EditorAnchor | null = null;
  /** 源码→渲染切换时记录的源码侧锚点（切换后定位用） */
  private pendingSourceAnchor: SourceExitAnchor | null = null;

  /** 源码文本/光标变化回调（供大纲 active 联动等消费方） */
  onCaretMove: ((text: string, pos: number) => void) | null = null;

  constructor(
    private readonly editor: Editor,
    private readonly fileService: FileService,
    private readonly app: HTMLElement,
    private readonly sourceEl: HTMLElement,
    private readonly button: HTMLButtonElement,
    private readonly onStateChange: () => void
  ) {
    // 源码编辑 → 脏检测 + 状态栏刷新
    this.sourceEl.addEventListener('input', () => {
      this.fileService.handleDocUpdated();
      this.scheduleHighlight();
      this.onStateChange();
      this.notifyCaretMove();
    });
    // 光标移动 → 行列刷新 + 大纲联动
    for (const event of ['keyup', 'click', 'select'] as const) {
      this.sourceEl.addEventListener(event, () => {
        this.onStateChange();
        this.notifyCaretMove();
      });
    }
    // Tab 键插入制表符而非移动焦点（与渲染模式 tabKey 插件行为一致）
    this.sourceEl.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        event.preventDefault();
        insertTextViaInputEvent(this.sourceEl, '\t');
        this.fileService.handleDocUpdated();
        this.onStateChange();
        this.notifyCaretMove();
      }
    });

    // 打开文件 / 新建后同步
    this.fileService.onContentReplaced = () => {
      if (this.active) this.setContent(this.displayContent());
    };

    this.button.addEventListener('click', () => this.toggle());
  }

  get isActive(): boolean {
    return this.active;
  }

  /** 获取纯文本内容 */
  getText(): string {
    return this.sourceEl.textContent || '';
  }

  /** 设置纯文本内容 */
  private setContent(text: string): void {
    this.sourceEl.textContent = text;
    this.refreshHighlight();
  }

  /** 获取光标位置 */
  private getCursorPos(): number {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return 0;

    const range = sel.getRangeAt(0);
    const preRange = document.createRange();
    preRange.selectNodeContents(this.sourceEl);
    preRange.setEnd(range.startContainer, range.startOffset);
    return preRange.toString().length;
  }

  /** 光标/输入变化回调（文本 + 偏移） */
  private notifyCaretMove(): void {
    this.onCaretMove?.(this.getText(), this.getCursorPos());
  }

  /* ---------- 语法高亮 ---------- */

  /** 立即按当前内容重建高亮（进入/程序化换内容时用） */
  private refreshHighlight(): void {
    if (!this.active) return;
    applySourceHighlight(this.sourceEl, this.getText());
  }

  /** 编辑输入后防抖重建高亮 */
  private scheduleHighlight(): void {
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.highlightTimer = setTimeout(() => {
      this.highlightTimer = null;
      this.refreshHighlight();
    }, HIGHLIGHT_DEBOUNCE_MS);
  }

  /** 状态栏数据源（仅源码模式返回） */
  getSourceState(): SourceStateSnapshot | null {
    return this.active ? { text: this.getText(), pos: this.getCursorPos() } : null;
  }

  /**
   * 源码视图应显示的内容：
   * 未编辑的文档直接显示磁盘原文（转义原样保留，不经过序列化）；
   * 已编辑的文档显示当前序列化结果（序列化器会尽量少添加转义）。
   */
  private displayContent(): string {
    return this.fileService.isDirty
      ? this.fileService.getRawMarkdown()
      : this.fileService.getOriginalMarkdown();
  }

  toggle(): void {
    if (this.active) this.exit();
    else this.enter();
  }

  enter(): void {
    if (this.active) return;
    this.active = true;

    // 进入前捕获渲染侧锚点：切过去后把源码光标/滚动放到同一位置
    this.pendingEditorAnchor = captureEditorAnchor(this.editor);

    this.setContent(this.displayContent());
    this.fileService.sourceAccessor = () => this.getText();

    this.app.classList.add('source-mode');
    this.button.classList.add('active');
    this.button.textContent = '¶ 渲染';
    this.button.title = '返回渲染视图 (Ctrl+/)';

    // setTimeout 而非 requestAnimationFrame：无头/后台窗口 rAF 可能被节流，
    // 定位/焦点必须在切换指令后必然执行（setTimeout 0 次帧排队同样满足时序）
    window.setTimeout(() => {
      const anchor = this.pendingEditorAnchor;
      this.pendingEditorAnchor = null;
      this.sourceEl.focus();
      if (!this.active || !anchor) return;
      const caret = anchorToSourceCaret(this.getText(), anchor);
      // 顶部对齐（与渲染模式跳转一致）+ 瞬时定位（避免从文档顶部滑过来的动画）
      if (caret !== null) placeSourceCaret(this.sourceEl, caret, 'top', 'auto');
    }, 0);
    this.onStateChange();
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;

    const value = this.getText();

    // 退出前记录源码锚点：write back 后把渲染光标放回同一处
    const caret = this.getCursorPos();
    const lines = sourceLines(value);
    this.pendingSourceAnchor = {
      lineText: lines[lineAt(lines, caret)]?.content ?? '',
      lineIndex: lineAt(lines, caret),
      lineCount: lines.length
    };

    // 先解除劫持再写回，确保脏检测对比的是真实文档内容
    this.fileService.sourceAccessor = null;
    setMarkdown(this.editor, value);

    // 清理高亮与防抖任务
    if (this.highlightTimer) {
      clearTimeout(this.highlightTimer);
      this.highlightTimer = null;
    }
    clearSourceHighlight();

    this.app.classList.remove('source-mode');
    this.button.classList.remove('active');
    // 与源码态「¶ 源码」等宽同构（</> 比 ¶ 宽，切换时按钮会跳动）
    this.button.textContent = '¶ 渲染';
    this.button.title = '切换源代码 / 渲染视图 (Ctrl+/)';
    this.onStateChange();

    // setMarkdown（replaceAll）是异步事务，等一帧文档就绪后再定位；若期间又切回源码则放弃。
    // setTimeout 而非 rAF：无头/后台窗口 rAF 可能被节流导致定位永不执行
    const anchor = this.pendingSourceAnchor;
    this.pendingSourceAnchor = null;
    window.setTimeout(() => {
      if (this.active) return;
      placeEditorCursor(this.editor, anchor);
    }, 0);
  }
}
