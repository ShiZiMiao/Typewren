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

/** 脏文档草稿自动落盘间隔 */
const DRAFT_AUTOSAVE_MS = 30_000;

/** 文档是否引用了同目录 assets/ 下的附件（另存为迁移提示用） */
function refsLocalAssets(markdown: string): boolean {
  return /(?:\]\(|src=["'])(?:\.\/)?assets\//i.test(markdown);
}

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

  /** 上一次草稿落盘使用的键（当前路径；null 表示从未同步过） */
  private lastDraftKey: string | null = null;

  /** 用户已选择放弃更改关闭：不再写草稿，beforeunload 静默跳过 */
  private abandonedForClose = false;

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

  /** 文档路径变化回调（文件树刷新等；loadContent / saveAs 成功后触发） */
  onPathChanged: (() => void) | null = null;

  constructor(
    private readonly api: TypewrenApi,
    private readonly editor: Editor
  ) {
    // 测试模式不碰用户数据目录（草稿/恢复整体静默）
    if (!api.testMode) {
      const intervalMs = Number(api.draftIntervalMs) || DRAFT_AUTOSAVE_MS;
      window.setInterval(() => this.syncDraft(), intervalMs);
      // 正常/意外关闭前都尽力把状态同步到草稿存储
      window.addEventListener('beforeunload', () => this.syncDraft());
    }
  }

  /* ---------- 崩溃恢复草稿 ---------- */

  /**
   * 把草稿状态与当前文档对齐：脏 → 落盘快照；干净/路径变化 → 清理。
   * 尽力而为（send 无回执），失败不影响编辑。
   * 启动时的崩溃草稿由主进程在创建窗口前统一消费，渲染层无需等待领取。
   */
  private syncDraft(): void {
    if (this.abandonedForClose) return;
    const key = this.filePath ?? '';
    if (this.lastDraftKey !== null && this.lastDraftKey !== key) {
      this.api.clearDraft(this.lastDraftKey);
    }
    this.lastDraftKey = key;
    if (this.isDirty) {
      this.api.saveDraft({ path: key, content: this.currentMarkdown });
    } else {
      this.api.clearDraft(key);
    }
  }

  /** 关闭保护中选择"不保存"：清掉草稿并请求主进程真正关闭窗口 */
  abandonForClose(): void {
    this.abandonedForClose = true;
    if (!this.api.testMode) this.api.clearDraft(this.filePath ?? '');
    this.api.requestForceClose();
  }

  /**
   * 崩溃恢复：以磁盘内容（不存在则空）为基线加载草稿，使文档呈"未保存修改"状态，
   * 用户确认后再 Ctrl+S 写回磁盘。
   */
  async restoreDraft(path: string, content: string): Promise<void> {
    const disk = path ? ((await this.api.readFileQuiet(path)) ?? '') : '';
    await this.loadContent(path || null, disk);
    setMarkdown(this.editor, content);
    this.refreshTitle();
  }

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
      this.api.setWindowPath(this.filePath);
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
    // 基线刚建立（打开/保存/新建），草稿状态应与之对齐（干净即清理）
    if (!this.api.testMode) this.syncDraft();
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
    this.onPathChanged?.();
    const savedAccessor = this.sourceAccessor;
    this.sourceAccessor = null;
    this.suppressDirty = true;
    try {
      setMarkdown(this.editor, content);
      // replaceAll 是异步事务，等待一帧让 markdownUpdated 触发完毕
      // （setTimeout 而非 rAF：无头/后台窗口 rAF 可能被节流）
      await new Promise((resolve) => window.setTimeout(resolve, 0));
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

  /** 当前窗口是否"空文档"（无路径且未修改）——决定就地在当前窗口打开还是新窗口 */
  private get isEmptyDocument(): boolean {
    return this.filePath === null && !this.isDirty;
  }

  async openFile(): Promise<void> {
    if (!(await this.confirmBeforeDiscard())) return;

    const result = await this.api.openFileDialog();
    if (!result) return;

    if (this.isEmptyDocument) {
      await this.loadContent(result.path, result.content);
    } else {
      window.typewren.openFileInNewWindow(result.path);
    }
  }

  /**
   * 打开指定路径（最近文件菜单 / 外部请求共用）：
   * 与「文件→打开…」同逻辑——当前窗口空文档则就地打开，否则新窗口打开。
   */
  async openSmart(path: string): Promise<void> {
    if (this.isEmptyDocument) {
      const result = await this.api.readFileContent(path);
      if (result) await this.loadContentFromPath(result.path, result.content);
    } else {
      window.typewren.openFileInNewWindow(path);
    }
  }

  /** 从指定路径加载文件内容（供文件关联打开使用） */
  async loadContentFromPath(path: string, content: string): Promise<void> {
    await this.loadContent(path, content);
  }

  /** 保存。返回 true 表示磁盘内容与当前一致（含另存为成功） */
  async save(): Promise<boolean> {
    if (!this.filePath) return await this.saveAs();

    // 外部修改冲突检测：磁盘内容与"上次读写的基线"不一致说明被其它程序改过，
    // 直接写会静默覆盖对方的修改
    const disk = await this.api.readFileQuiet(this.filePath);
    if (disk !== null && disk !== this.savedMarkdown) {
      const choice = await this.api.confirmDialog({
        message: '文件已被其它程序修改',
        detail:
          '「覆盖保存」将丢失外部更改；「重新载入磁盘版本」将丢弃你当前的编辑内容（此操作不可撤销）。',
        buttons: ['覆盖保存', '重新载入磁盘版本', '取消'],
        cancelId: 2
      });
      if (choice === null || choice === 2) return false;
      if (choice === 1) {
        await this.loadContent(this.filePath, disk);
        return true;
      }
    }

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
    const previousPath = this.filePath;
    const suggestedName = this.filePath ? this.fileName : '未命名.md';

    const result = await this.api.saveFileDialog({
      content,
      suggestedName
    });
    if (!result) return false;

    this.filePath = result.path;
    this.originalMarkdown = content;
    this.onPathChanged?.();
    this.snapshot(content);

    // 另存为到新位置且文档引用 ./assets/：附件留在原地会断链，提示迁移
    if (
      !this.api.testMode &&
      previousPath &&
      previousPath !== result.path &&
      refsLocalAssets(content)
    ) {
      const choice = await this.api.confirmDialog({
        message: '是否同时复制附件文件夹（assets）到新位置？',
        detail: '不复制的话，文档中引用 ./assets/ 的图片在新位置可能无法显示。',
        buttons: ['复制', '不复制'],
        cancelId: 1
      });
      if (choice === 0) {
        const copy = await this.api.copyAssets({ fromDoc: previousPath, toDoc: result.path });
        if (!copy.ok) {
          await this.api.confirmDialog({
            message: `附件复制失败：${copy.error ?? '未知错误'}`,
            buttons: ['知道了']
          });
        }
      }
    }
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
