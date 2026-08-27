import type { Editor } from '@milkdown/kit/core'

import { setMarkdown } from '../editor/actions'
import type { FileService } from '../services/fileService'

/* ============================================================
 * 源代码 / 渲染视图切换控制器
 * - 进入：渲染视图内容 → textarea，隐藏编辑器
 * - 编辑期间通过 fileService.sourceAccessor 劫持内容读取，
 *   保证脏检测 / 保存 / 另存为使用 textarea 的实时内容
 * - 退出：textarea 内容整体写回 Milkdown，恢复渲染视图
 * ============================================================ */

export interface SourceStateSnapshot {
  text: string
  pos: number
}

export class SourceModeController {
  private active = false

  constructor(
    private readonly editor: Editor,
    private readonly fileService: FileService,
    private readonly app: HTMLElement,
    private readonly textarea: HTMLTextAreaElement,
    private readonly button: HTMLButtonElement,
    private readonly onStateChange: () => void
  ) {
    // 源码编辑 → 脏检测 + 状态栏刷新
    this.textarea.addEventListener('input', () => {
      this.fileService.handleDocUpdated()
      this.onStateChange()
    })
    // 光标移动 → 行列刷新
    for (const event of ['keyup', 'click', 'select'] as const) {
      this.textarea.addEventListener(event, () => this.onStateChange())
    }
    // Tab 键插入两个空格而非移动焦点
    this.textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        event.preventDefault()
        const { selectionStart, selectionEnd } = this.textarea
        this.textarea.setRangeText(
          '  ',
          selectionStart,
          selectionEnd,
          'end'
        )
        this.fileService.handleDocUpdated()
        this.onStateChange()
      }
    })

    // 打开文件 / 新建后同步 textarea
    this.fileService.onContentReplaced = () => {
      if (this.active) this.textarea.value = this.fileService.getRawMarkdown()
    }

    this.button.addEventListener('click', () => this.toggle())
  }

  get isActive(): boolean {
    return this.active
  }

  /** 状态栏数据源（仅源码模式返回） */
  getSourceState(): SourceStateSnapshot | null {
    return this.active
      ? { text: this.textarea.value, pos: this.textarea.selectionStart ?? 0 }
      : null
  }

  toggle(): void {
    if (this.active) this.exit()
    else this.enter()
  }

  enter(): void {
    if (this.active) return
    this.active = true

    this.textarea.value = this.fileService.getRawMarkdown()
    this.fileService.sourceAccessor = () => this.textarea.value

    this.app.classList.add('source-mode')
    this.button.classList.add('active')
    this.button.textContent = '¶ 渲染'
    this.button.title = '返回渲染视图 (Ctrl+/)'

    requestAnimationFrame(() => {
      this.textarea.focus()
      this.textarea.setSelectionRange(0, 0)
    })
    this.onStateChange()
  }

  exit(): void {
    if (!this.active) return
    this.active = false

    const value = this.textarea.value

    // 先解除劫持再写回，确保脏检测对比的是真实文档内容
    this.fileService.sourceAccessor = null
    setMarkdown(this.editor, value)

    this.app.classList.remove('source-mode')
    this.button.classList.remove('active')
    this.button.textContent = '</> 源码'
    this.button.title = '切换源代码 / 渲染视图 (Ctrl+/)'
    this.onStateChange()
  }
}
