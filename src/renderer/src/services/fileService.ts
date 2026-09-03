import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx } from '@milkdown/kit/core';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';

import type { TypewrenApi } from '../env.d';
import { getMarkdown, setMarkdown } from '../editor/actions';

/* ============================================================
 * 文件服务：新建 / 打开 / 保存 / 另存为 + 脏状态与窗口标题管理
 *
 * 脏检测（关键决策）：
 * - 源码模式：当前文本与“上次打开/保存时的磁盘文本”逐字比较。
 *   因此未编辑的文档即使序列化往返会丢转义（a\~\~b → a~~b），
 *   状态仍是“干净”，且源码视图可放心显示磁盘原文。
 * - 渲染模式：编辑器文档与基线文档做 ProseMirror 深度比较（doc.eq），
 *   比整篇序列化成字符串再比较更快，且“撤销到打开时状态”自然回干净。
 * ============================================================ */

export class FileService {
  /** 当前文件绝对路径；null 表示未命名文档 */
  private filePath: string | null = null;

  /** 上次保存 / 打开时的 Markdown 原文（磁盘内容）；源码模式脏检测基准 */
  private savedMarkdown = '';

  /** savedMarkdown 解析出的文档快照；渲染模式脏检测基准 */
  private baselineDoc: ProseNode | null = null;

  /** 加载 / 新建时的文件原始内容；源码模式“原样读取”的数据来源 */
  private originalMarkdown = '';

  /** 程序化替换内容期间抑制脏标记 */
  private suppressDirty = false;

  /** 标题同步节流计时器（输入高频时避免每键 3 次 IPC + DOM 写） */
  private titleTimer: number | undefined;

  /**
   * 源码模式下由 SourceModeController 注入：
   * 使 currentMarkdown 反映 textarea 的实时内容，保证脏检测与保存正确。
   */
  sourceAccessor: (() => string) | null = null;

  /** 文档被程序化整体替换后回调（供源码视图刷新自身内容） */
  onContentReplaced: (() => void) | null = null;

  /** 标题变化回调（供自绘标题栏同步显示） */
  onTitleChange: ((title: string) => void) | null = null;

  constructor(
    private readonly api: TypewrenApi,
    private readonly editor: Editor
  ) {}

  get currentMarkdown(): string {
    return this.sourceAccessor ? this.sourceAccessor() : getMarkdown(this.editor);
  }

  /** 始终读取渲染视图（Milkdown 文档）的 Markdown，不受源码模式影响 */
  getRawMarkdown(): string {
    return getMarkdown(this.editor);
  }

  /** 加载 / 新建时的文件原始内容（未编辑文档的源码视图直接显示它，保证原样） */
  getOriginalMarkdown(): string {
    return this.originalMarkdown;
  }

  get isDirty(): boolean {
    if (this.sourceAccessor) {
      // 源码模式：与上次打开/保存的磁盘文本逐字比较
      return this.sourceAccessor() !== this.savedMarkdown;
    }
    // 渲染模式：文档深度比较（撤销回基线状态自动变干净）
    const doc = this.editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
    return !this.baselineDoc || !doc.eq(this.baselineDoc);
  }

  get fileName(): string {
    if (!this.filePath) return '未命名文档';
    const normalized = this.filePath.replace(/\\/g, '/');
    return normalized.slice(normalized.lastIndexOf('/') + 1);
  }

  /** 获取当前文件路径 */
  getFilePath(): string | null {
    return this.filePath;
  }

  /* ---------- 内部工具 ---------- */

  /** 标题同步（节流）：输入触发时最多 80ms 一跳，与状态栏一致 */
  private refreshTitle(): void {
    window.clearTimeout(this.titleTimer);
    this.titleTimer = window.setTimeout(() => {
      this.titleTimer = undefined;
      const dirtyMark = this.isDirty ? '● ' : '';
      this.api.setTitle(`${dirtyMark}${this.fileName} — Typewren`);
      this.api.setDirty(this.isDirty);
      this.onTitleChange?.(`${dirtyMark}${this.fileName}`);
    }, 80);
  }

  /** 以“下次期望的磁盘内容”为基线建立快照（打开/新建/保存后） */
  private snapshot(markdown: string): void {
    this.savedMarkdown = markdown;
    // 基线文档直接取编辑器当前 doc：setMarkdown/replaceAll 事务产物与
    // parse(markdown) 存在细微结构差异，重新解析会假阳性置脏。
    this.baselineDoc = this.currentDoc();
    this.refreshTitle();
  }

  private currentDoc(): ProseNode | null {
    try {
      return this.editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
    } catch {
      return null;
    }
  }

  private async loadContent(path: string | null, content: string): Promise<void> {
    this.filePath = path;
    this.originalMarkdown = content;
    const savedAccessor = this.sourceAccessor;
    this.sourceAccessor = null;
    this.suppressDirty = true;
    try {
      setMarkdown(this.editor, content);
      // replaceAll 是异步事务，等待一帧让 markdownUpdated 触发完毕
      await new Promise((resolve) => requestAnimationFrame(resolve));
    } finally {
      this.suppressDirty = false;
      // 恢复访问器并让源码视图同步新文档内容
      if (this.onContentReplaced && savedAccessor) {
        this.sourceAccessor = savedAccessor;
        this.onContentReplaced();
      }
    }
    this.snapshot(content);
  }

  /** 文档被用户编辑（由编辑器回调触发） */
  handleDocUpdated(): void {
    if (this.suppressDirty) return;
    this.refreshTitle();
  }

  /** 启动 / 初始化完成后建立干净基线（当前内容视为已保存状态） */
  markBaseline(): void {
    const baseline = this.getRawMarkdown();
    // 首启欢迎文档没有文件源，源码视图只能显示序列化结果
    if (!this.filePath && this.originalMarkdown === '') {
      this.originalMarkdown = baseline;
    }
    this.snapshot(baseline);
  }

  /* ---------- 有未保存更改时的确认流程 ---------- */

  private async confirmBeforeDiscard(): Promise<boolean> {
    if (!this.isDirty) return true;

    const choice = await this.api.confirmDiscardChanges();
    if (choice === 'cancel') return false;
    if (choice === 'discard') return true;

    // 'save'：先保存，保存成功才继续
    return await this.save();
  }

  /* ---------- 四个公开操作 ---------- */

  async newFile(): Promise<void> {
    if (!(await this.confirmBeforeDiscard())) return;
    await this.loadContent(null, '');
  }

  async openFile(): Promise<void> {
    if (!(await this.confirmBeforeDiscard())) return;

    const result = await this.api.openFileDialog();
    if (!result) return;

    await this.loadContent(result.path, result.content);
  }

  /** 从指定路径加载文件内容（供文件关联打开使用） */
  async loadContentFromPath(path: string, content: string): Promise<void> {
    await this.loadContent(path, content);
  }

  /** 保存。返回 true 表示磁盘内容与当前一致（含另存为成功） */
  async save(): Promise<boolean> {
    if (!this.filePath) return await this.saveAs();

    const content = this.currentMarkdown;
    const ok = await this.api.writeFile({ path: this.filePath, content });
    if (ok) {
      this.originalMarkdown = content;
      this.snapshot(content);
    }
    return ok;
  }

  async saveAs(): Promise<boolean> {
    const content = this.currentMarkdown;
    const suggestedName = this.filePath ? this.fileName : '未命名.md';

    const result = await this.api.saveFileDialog({
      content,
      suggestedName
    });
    if (!result) return false;

    this.filePath = result.path;
    this.originalMarkdown = content;
    this.snapshot(content);
    return true;
  }

  /**
   * 关闭前保存流程（由主进程关闭保护触发）。
   * 成功保存后请求主进程真正关闭窗口；
   * 用户取消另存为则什么都不做（窗口保持打开）。
   */
  async saveThenClose(): Promise<void> {
    const ok = await this.save();
    if (ok) this.api.requestForceClose();
  }
}
