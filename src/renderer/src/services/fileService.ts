import type { Editor } from '@milkdown/kit/core'

import type { TypewrenApi } from '../env.d'
import {
  getMarkdown,
  setMarkdown as replaceDocument
} from '../editor/actions'

/* ============================================================
 * 文件服务：新建 / 打开 / 保存 / 另存为 + 脏状态与窗口标题管理
 * ============================================================ */

export class FileService {
  /** 当前文件绝对路径；null 表示未命名文档 */
  private filePath: string | null = null

  /** 上次保存 / 打开时的 Markdown 快照，用于脏检测 */
  private savedMarkdown = ''

  /** 程序化替换内容期间抑制脏标记 */
  private suppressDirty = false

  /**
   * 源码模式下由 SourceModeController 注入：
   * 使 currentMarkdown 反映 textarea 的实时内容，保证脏检测与保存正确。
   */
  sourceAccessor: (() => string) | null = null

  /** 文档被程序化整体替换后回调（供源码视图刷新自身内容） */
  onContentReplaced: (() => void) | null = null

  /** 标题变化回调（供自绘标题栏同步显示） */
  onTitleChange: ((title: string) => void) | null = null

  constructor(
    private readonly api: TypewrenApi,
    private readonly editor: Editor
  ) {}

  get currentMarkdown(): string {
    return this.sourceAccessor ? this.sourceAccessor() : getMarkdown(this.editor)
  }

  /** 始终读取渲染视图（Milkdown 文档）的 Markdown，不受源码模式影响 */
  getRawMarkdown(): string {
    return getMarkdown(this.editor)
  }

  get isDirty(): boolean {
    return this.currentMarkdown !== this.savedMarkdown
  }

  get fileName(): string {
    if (!this.filePath) return '未命名文档'
    const normalized = this.filePath.replace(/\\/g, '/')
    return normalized.slice(normalized.lastIndexOf('/') + 1)
  }

  /** 获取当前文件路径 */
  getFilePath(): string | null {
    return this.filePath
  }

  /* ---------- 内部工具 ---------- */

  private refreshTitle(): void {
    const dirtyMark = this.isDirty ? '● ' : ''
    this.api.setTitle(`${dirtyMark}${this.fileName} — Typewren`)
    this.api.setDirty(this.isDirty)
    this.onTitleChange?.(`${dirtyMark}${this.fileName}`)
  }

  private snapshot(): void {
    this.savedMarkdown = this.currentMarkdown
    this.refreshTitle()
  }

  private async loadContent(path: string | null, content: string): Promise<void> {
    this.filePath = path
    const savedAccessor = this.sourceAccessor
    this.sourceAccessor = null
    this.suppressDirty = true
    try {
      replaceDocument(this.editor, content)
      // replaceAll 是异步事务，等待一帧让 markdownUpdated 触发完毕
      await new Promise((resolve) => requestAnimationFrame(resolve))
    } finally {
      this.suppressDirty = false
      // 恢复访问器并让源码视图同步新文档内容
      if (this.onContentReplaced && savedAccessor) {
        this.sourceAccessor = savedAccessor
        this.onContentReplaced()
      }
    }
    this.snapshot()
  }

  /** 文档被用户编辑（由编辑器回调触发） */
  handleDocUpdated(): void {
    if (this.suppressDirty) return
    this.refreshTitle()
  }

  /** 启动 / 初始化完成后建立干净基线（当前内容视为已保存状态） */
  markBaseline(): void {
    this.savedMarkdown = this.getRawMarkdown()
    this.refreshTitle()
  }

  /* ---------- 有未保存更改时的确认流程 ---------- */

  private async confirmBeforeDiscard(): Promise<boolean> {
    if (!this.isDirty) return true

    const choice = await this.api.confirmDiscardChanges()
    if (choice === 'cancel') return false
    if (choice === 'discard') return true

    // 'save'：先保存，保存成功才继续
    return await this.save()
  }

  /* ---------- 四个公开操作 ---------- */

  async newFile(): Promise<void> {
    if (!(await this.confirmBeforeDiscard())) return
    await this.loadContent(null, '')
  }

  async openFile(): Promise<void> {
    if (!(await this.confirmBeforeDiscard())) return

    const result = await this.api.openFileDialog()
    if (!result) return

    await this.loadContent(result.path, result.content)
  }

  /** 从指定路径加载文件内容（供文件关联打开使用） */
  async loadContentFromPath(path: string, content: string): Promise<void> {
    await this.loadContent(path, content)
  }

  /** 保存。返回 true 表示磁盘内容与当前一致（含另存为成功） */
  async save(): Promise<boolean> {
    if (!this.filePath) return await this.saveAs()

    const content = this.currentMarkdown
    const ok = await this.api.writeFile({ path: this.filePath, content })
    if (ok) this.snapshot()
    return ok
  }

  async saveAs(): Promise<boolean> {
    const content = this.currentMarkdown
    const suggestedName = this.filePath
      ? this.fileName
      : '未命名.md'

    const result = await this.api.saveFileDialog({
      content,
      suggestedName
    })
    if (!result) return false

    this.filePath = result.path
    this.snapshot()
    return true
  }

  /**
   * 关闭前保存流程（由主进程关闭保护触发）。
   * 成功保存后请求主进程真正关闭窗口；
   * 用户取消另存为则什么都不做（窗口保持打开）。
   */
  async saveThenClose(): Promise<void> {
    const ok = await this.save()
    if (ok) this.api.requestForceClose()
  }
}
