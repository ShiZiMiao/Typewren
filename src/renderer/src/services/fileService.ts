import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx } from '@milkdown/kit/core';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';

import type { TypewrenApi } from '../../../shared/typewren-api';
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
 *
 * 基线成对（勿拆开取）：savedMarkdown 与 baselineDoc 必须同一瞬间捕获。
 * 保存路径上 content 先取、写盘 await 之后再取 doc 会在"保存间隙继续键入"
 * 时把新键入也烧进基线 → isDirty 假阴（关闭保护不弹、syncDraft 清草稿静默丢字）。
 * ============================================================ */

/** 脏文档草稿自动落盘默认间隔（偏好设置 draftInterval 可改，测试可用
 * --draft-interval= 覆盖 —— 该覆盖优先级最高，见 forcedDraftIntervalMs） */
const DRAFT_AUTOSAVE_MS = 30_000;

/** 保存结果三态：调用方只在 'saved' 时继续"清空/关闭"等破坏性后续——
 * 'reloaded' 表示本地编辑已被磁盘版本替换（不是保存成功），'canceled' 什么都没做 */
export type SaveOutcome = 'saved' | 'reloaded' | 'canceled';

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

  /** 程序化替换内容期间抑制脏标记（loadContent 等帧窗口期） */
  private suppressDirty = false;

  /** 源码模式访问器（见下方 get/set：setter 顺带捕获退出写回的文本快照） */
  private sourceAccessorField: (() => string) | null = null;

  /**
   * 源码模式退出时的写回文本快照（sourceMode 先置 null 再 setMarkdown 写回）。
   * 写回的 doc 是重新 parse 的产物，与过期 baselineDoc 不等会假阳置脏
   * （刚保存完切回渲染仍显示 ●）——handleDocUpdated 里按此快照重建基线。
   */
  private pendingSourceWriteBack: string | null = null;

  /** 上一次草稿落盘使用的键（当前路径；null 表示从未同步过） */
  private lastDraftKey: string | null = null;

  /** 用户已选择放弃更改关闭：不再写草稿，beforeunload 静默跳过 */
  private abandonedForClose = false;

  /** 标题同步节流计时器（输入高频时避免每键 3 次 IPC + DOM 写） */
  private titleTimer: number | undefined;

  /**
   * 源码模式下由 SourceModeController 注入：
   * 使 currentMarkdown 反映 textarea 的实时内容，保证脏检测与保存正确。
   * 置回 null（退出源码）时捕获此刻文本作为"写回快照"——随后的
   * setMarkdown 写回完成后据此判断是否重建基线（见 pendingSourceWriteBack）。
   */
  get sourceAccessor(): (() => string) | null {
    return this.sourceAccessorField;
  }

  set sourceAccessor(accessor: (() => string) | null) {
    if (accessor === null && this.sourceAccessorField) {
      this.pendingSourceWriteBack = this.sourceAccessorField();
    } else {
      this.pendingSourceWriteBack = null;
    }
    this.sourceAccessorField = accessor;
  }

  /** 文档被程序化整体替换后回调（供源码视图刷新自身内容） */
  onContentReplaced: (() => void) | null = null;

  /** 标题变化回调（供自绘标题栏同步显示） */
  onTitleChange: ((title: string) => void) | null = null;

  /** 文档路径变化回调（文件树刷新等；loadContent / saveAs 成功后触发） */
  onPathChanged: (() => void) | null = null;

  /** 草稿落盘定时器（偏好设置 draftInterval 驱动） */
  private draftTimer: number | undefined;
  /** 偏好设置中的草稿间隔（ms）；--draft-interval= 测试覆盖优先 */
  private settingsDraftMs = DRAFT_AUTOSAVE_MS;

  /** 自动保存定时器句柄（偏好设置 autoSave 驱动） */
  private autoSaveTimer: number | undefined;
  /** 自动保存间隔（ms） */
  private autoSaveMs = 60_000;
  /** 自动保存进行中标志：防止上一轮未写完时并发触发 */
  private autoSaveInFlight = false;

  constructor(
    private readonly api: TypewrenApi,
    private readonly editor: Editor
  ) {
    // 测试模式不碰用户数据目录（草稿/恢复整体静默）
    if (!api.testMode) {
      window.addEventListener('beforeunload', () => this.syncDraft());
    }
    this.setDraftTimer(this.draftIntervalMs());
  }

  /** 草稿间隔：--draft-interval= 测试覆盖优先，否则取偏好设置 */
  private draftIntervalMs(): number {
    const forced = Number(this.api.draftIntervalMs);
    return forced > 0 ? forced : this.settingsDraftMs;
  }

  private setDraftTimer(intervalMs: number): void {
    window.clearInterval(this.draftTimer);
    this.draftTimer = undefined;
    // 测试模式不落草稿（drafts 主进程侧也未注册）
    if (this.api.testMode || intervalMs <= 0) return;
    this.draftTimer = window.setInterval(() => this.syncDraft(), intervalMs);
  }

  /* ---------- 偏好设置接入点（appSettings 应用器回调） ---------- */

  /** 偏好设置：崩溃恢复草稿间隔（秒）。测试用 --draft-interval= 覆盖不受设置影响 */
  setDraftInterval(sec: number): void {
    this.settingsDraftMs = Math.max(1, sec) * 1000;
    this.setDraftTimer(this.draftIntervalMs());
  }

  /** 偏好设置：自动保存。开启时定时把脏文档写盘（无路径文档不主动弹另存为） */
  setAutoSave(enabled: boolean, intervalSec: number): void {
    this.autoSaveMs = Math.max(1, intervalSec) * 1000;
    window.clearInterval(this.autoSaveTimer);
    this.autoSaveTimer = undefined;
    if (!enabled) return;
    this.autoSaveTimer = window.setInterval(() => {
      void this.autoSaveTick();
    }, this.autoSaveMs);
  }

  private async autoSaveTick(): Promise<void> {
    if (this.autoSaveInFlight || this.abandonedForClose) return;
    if (!this.filePath || !this.isDirty) return;
    this.autoSaveInFlight = true;
    try {
      await this.save();
    } finally {
      this.autoSaveInFlight = false;
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
    // 程序化替换内容的等帧窗口期（loadContent）恒干净：此时基线还停在旧文档上，
    // 草稿定时器/autoSaveTick 拿旧基线比较会为刚打开的干净文件落脏草稿、
    // 甚至以旧基线误报冲突写盘
    if (this.suppressDirty) return false;
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

  /** 标题同步：脏标记即时发送（关闭保护读的是它，挂节流会留"编辑后 80ms 内
   * 关窗绕过保护"的窗口），仅标题/路径/回调走 80ms 节流 */
  private refreshTitle(): void {
    this.api.setDirty(this.isDirty);
    window.clearTimeout(this.titleTimer);
    this.titleTimer = window.setTimeout(() => {
      this.titleTimer = undefined;
      const dirtyMark = this.isDirty ? '● ' : '';
      this.api.setTitle(`${dirtyMark}${this.fileName} — Typewren`);
      this.api.setWindowPath(this.filePath);
      this.onTitleChange?.(`${dirtyMark}${this.fileName}`);
    }, 80);
  }

  /**
   * 以“下次期望的磁盘内容”为基线建立快照（打开/新建/保存后）。
   * doc 传参用于保存链路：content 与 doc 必须在写盘 await 之前同一瞬间成对捕获，
   * 否则保存间隙的继续键入会被烧进基线（isDirty 假阴）。
   */
  private snapshot(markdown: string, doc: ProseNode | null = this.currentDoc()): void {
    this.savedMarkdown = markdown;
    // 基线文档直接取编辑器当前 doc：setMarkdown/replaceAll 事务产物与
    // parse(markdown) 存在细微结构差异，重新解析会假阳性置脏。
    this.baselineDoc = doc;
    // 基线刚建立（打开/保存/新建），挂起的源码写回快照一并作废
    this.pendingSourceWriteBack = null;
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
      // 上面 setter 置 null 时把旧源码文本记成了"写回快照"——那是打开/新建
      // 的程序化替换，不是源码写回，作废之
      this.pendingSourceWriteBack = null;
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
    // 源码退出的写回事务在这里落地：写回文本与磁盘基线一致时重建快照，
    // 否则重新 parse 出的 doc 与过期 baselineDoc 不等会假阳置脏（刚保存仍 ●）
    if (this.pendingSourceWriteBack !== null) {
      const written = this.pendingSourceWriteBack;
      this.pendingSourceWriteBack = null;
      if (written === this.savedMarkdown) {
        this.snapshot(written);
        return;
      }
    }
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

    // 'save'：先保存；只有真正写盘成功才继续（'reloaded' 是本地编辑被磁盘
    // 版本替换，绝不能当保存成功继续清空/打开覆盖）
    return (await this.save()) === 'saved';
  }

  /* ---------- 保存链（串行化） ---------- */

  /**
   * 保存队列：手动保存 / 自动保存 / 保存并关闭共用一条链，新保存排队到前一个
   * 完成。没有它时并发交错会：双写盘、冲突确认框双弹、saveThenClose 在自动
   * 保存的对话框未决时直接强关窗口。内部实现走 doSave/doSaveAs（不再入队，
   * 否则自嵌套死锁）。
   */
  private saveChain: Promise<unknown> = Promise.resolve();

  private enqueueSave(run: () => Promise<SaveOutcome>): Promise<SaveOutcome> {
    const next = this.saveChain.then(() => run());
    // 链尾吞掉失败：队列本身永不 reject，前一次保存抛错不阻塞后续
    this.saveChain = next.catch(() => undefined);
    return next;
  }

  /** 保存（排队）。三态里只有 'saved' 是"磁盘内容由本次写入对齐" */
  async save(): Promise<SaveOutcome> {
    return this.enqueueSave(() => this.doSave());
  }

  /** 另存为（排队） */
  async saveAs(): Promise<SaveOutcome> {
    return this.enqueueSave(() => this.doSaveAs());
  }

  private async doSave(): Promise<SaveOutcome> {
    if (!this.filePath) return await this.doSaveAs();

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
      if (choice === null || choice === 2) return 'canceled';
      if (choice === 1) {
        await this.loadContent(this.filePath, disk);
        // 本地编辑已被磁盘版本替换——这不是"保存成功"，调用方（新建/关闭等
        // 破坏性后续）不得据此继续，否则刚重载的文档会被清空/关窗
        return 'reloaded';
      }
    }

    // 基线成对：content 与 doc 在写盘 await 之前同一瞬间捕获——保存间隙继续
    // 键入的内容不进基线（保持"保存后继续打字 → 仍脏"，关闭保护照常触发）
    const content = this.currentMarkdown;
    const doc = this.currentDoc();
    const ok = await this.api.writeFile({ path: this.filePath, content });
    if (ok) {
      this.originalMarkdown = content;
      this.snapshot(content, doc);
      return 'saved';
    }
    // 写盘失败（主进程已弹错误框）：什么都没保存成，视同取消
    return 'canceled';
  }

  private async doSaveAs(): Promise<SaveOutcome> {
    // 基线成对：content 会先被对话框写盘，doc 取同一瞬间（对话框停留期间的
    // 编辑不进基线）
    const content = this.currentMarkdown;
    const doc = this.currentDoc();
    const previousPath = this.filePath;
    const suggestedName = this.filePath ? this.fileName : '未命名.md';

    const result = await this.api.saveFileDialog({
      content,
      suggestedName
    });
    if (!result) return 'canceled';

    this.filePath = result.path;
    this.originalMarkdown = content;
    this.onPathChanged?.();
    this.snapshot(content, doc);

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
    return 'saved';
  }

  /**
   * 关闭前保存流程（由主进程关闭保护触发）。
   * 成功保存后请求主进程真正关闭窗口；
   * 用户取消另存为 / 选了「重新载入磁盘版本」都保持窗口打开。
   */
  async saveThenClose(): Promise<void> {
    const outcome = await this.save();
    if (outcome === 'saved') this.api.requestForceClose();
  }

  /* ---------- 四个公开操作 ---------- */

  /** 新建空白文档（有未保存更改先走确认流程） */
  async newFile(): Promise<void> {
    if (!(await this.confirmBeforeDiscard())) return;
    await this.loadContent(null, '');
  }

  /**
   * 当前窗口是否"空文档"——决定就地在当前窗口打开还是新窗口。
   * 除"无路径且干净"外还要求**内容为空**：欢迎页/撤销回干净态的有内容文档
   * 只看脏标记会被就地覆盖且无提示（内容静默消失）。
   */
  private get isEmptyDocument(): boolean {
    // 路径判空用 falsy：open-file-path 空串路径的窗口同样是"未保存"语义
    return !this.filePath && !this.isDirty && this.currentMarkdown.trim().length === 0;
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
}
