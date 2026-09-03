import type { Editor } from '@milkdown/kit/core';

import { setMarkdown } from '../editor/actions';
import type { FileService } from '../services/fileService';
import { insertTextViaInputEvent } from '../util/inputEvent';
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
    // Tab 键插入两个空格而非移动焦点
    this.sourceEl.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        event.preventDefault();
        insertTextViaInputEvent(this.sourceEl, '  ');
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

    this.setContent(this.displayContent());
    this.fileService.sourceAccessor = () => this.getText();

    this.app.classList.add('source-mode');
    this.button.classList.add('active');
    this.button.textContent = '¶ 渲染';
    this.button.title = '返回渲染视图 (Ctrl+/)';

    requestAnimationFrame(() => {
      this.sourceEl.focus();
    });
    this.onStateChange();
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;

    const value = this.getText();

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
    this.button.textContent = '</> 源码';
    this.button.title = '切换源代码 / 渲染视图 (Ctrl+/)';
    this.onStateChange();
  }
}
