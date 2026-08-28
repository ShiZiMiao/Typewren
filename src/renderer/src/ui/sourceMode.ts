import type { Editor } from '@milkdown/kit/core'

import { setMarkdown } from '../editor/actions'
import type { FileService } from '../services/fileService'

/* ============================================================
 * 源代码 / 渲染视图切换控制器
 * 使用 contenteditable div 支持 CSS Custom Highlight API
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
    private readonly sourceEl: HTMLElement,
    private readonly button: HTMLButtonElement,
    private readonly onStateChange: () => void
  ) {
    // 源码编辑 → 脏检测 + 状态栏刷新
    this.sourceEl.addEventListener('input', () => {
      this.fileService.handleDocUpdated()
      this.onStateChange()
    })
    // 光标移动 → 行列刷新
    for (const event of ['keyup', 'click', 'select'] as const) {
      this.sourceEl.addEventListener(event, () => this.onStateChange())
    }
    // Tab 键插入两个空格而非移动焦点
    this.sourceEl.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        event.preventDefault()
        document.execCommand('insertText', false, '  ')
        this.fileService.handleDocUpdated()
        this.onStateChange()
      }
    })

    // 打开文件 / 新建后同步
    this.fileService.onContentReplaced = () => {
      if (this.active) this.setContent(this.fileService.getRawMarkdown())
    }

    this.button.addEventListener('click', () => this.toggle())
  }

  get isActive(): boolean {
    return this.active
  }

  /** 获取纯文本内容 */
  getText(): string {
    return this.sourceEl.textContent || ''
  }

  /** 设置纯文本内容 */
  private setContent(text: string): void {
    this.sourceEl.textContent = text
  }

  /** 获取光标位置 */
  private getCursorPos(): number {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return 0

    const range = sel.getRangeAt(0)
    const preRange = document.createRange()
    preRange.selectNodeContents(this.sourceEl)
    preRange.setEnd(range.startContainer, range.startOffset)
    return preRange.toString().length
  }

  /** 状态栏数据源（仅源码模式返回） */
  getSourceState(): SourceStateSnapshot | null {
    return this.active
      ? { text: this.getText(), pos: this.getCursorPos() }
      : null
  }

  toggle(): void {
    if (this.active) this.exit()
    else this.enter()
  }

  enter(): void {
    if (this.active) return
    this.active = true

    this.setContent(this.fileService.getRawMarkdown())
    this.fileService.sourceAccessor = () => this.getText()

    this.app.classList.add('source-mode')
    this.button.classList.add('active')
    this.button.textContent = '¶ 渲染'
    this.button.title = '返回渲染视图 (Ctrl+/)'

    requestAnimationFrame(() => {
      this.sourceEl.focus()
    })
    this.onStateChange()
  }

  exit(): void {
    if (!this.active) return
    this.active = false

    const value = this.getText()

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
