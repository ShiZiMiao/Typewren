import type { Editor } from '@milkdown/kit/core'
import { editorViewCtx } from '@milkdown/kit/core'
import { TextSelection } from '@milkdown/kit/prose/state'

export interface OutlineEntry {
  level: number
  text: string
  /** 标题在文档中的序号（用于点击时重新定位） */
  index: number
}

/** 从当前文档收集全部标题（含位置信息） */
function collectHeadings(editor: Editor): (OutlineEntry & { pos: number })[] {
  const entries: (OutlineEntry & { pos: number })[] = []

  editor.action((ctx) => {
    const doc = ctx.get(editorViewCtx).state.doc

    doc.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        entries.push({
          level: Number(node.attrs.level),
          text: node.textContent.trim() || `标题 ${entries.length + 1}`,
          pos,
          index: entries.length
        })
      }
      return true
    })
  })

  return entries
}

export interface OutlineController {
  refresh(): void
  setActive(index: number | null): void
  jumpTo(index: number): void
}

export function createOutlinePanel(
  editor: Editor,
  treeEl: HTMLElement
): OutlineController {
  let entries: (OutlineEntry & { pos: number })[] = []
  let buttons: HTMLButtonElement[] = []

  function rebuildDom(): void {
    treeEl.innerHTML = ''
    buttons = []

    if (entries.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'outline-empty'
      empty.textContent = '暂无标题，使用 # 创建'
      treeEl.appendChild(empty)
      return
    }

    for (const entry of entries) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'outline-item'
      btn.dataset.level = String(entry.level)
      btn.title = entry.text
      btn.textContent = entry.text
      btn.addEventListener('click', () => controller.jumpTo(entry.index))
      treeEl.appendChild(btn)
      buttons.push(btn)
    }
  }

  const controller: OutlineController = {
    refresh(): void {
      const prevTexts = entries.map((e) => `${e.level}:${e.text}`).join('\n')
      entries = collectHeadings(editor)
      const nextTexts = entries.map((e) => `${e.level}:${e.text}`).join('\n')

      // 内容未变时保留按钮引用与滚动位置，避免闪烁
      if (prevTexts !== nextTexts || buttons.length !== entries.length) {
        rebuildDom()
      }
    },

    setActive(index: number | null): void {
      buttons.forEach((btn, i) => {
        btn.classList.toggle('active', i === index)
        if (i === index) {
          btn.scrollIntoView({ block: 'nearest' })
        }
      })
    },

    jumpTo(index: number): void {
      const target = entries[index]
      if (!target) return

let scrollTarget = 0
      let container: HTMLElement | null = null
      let pmDom: HTMLElement | null = null

      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        const $pos = view.state.doc.resolve(target.pos + 1)
        const selection = TextSelection.near($pos, 1)
        view.dispatch(view.state.tr.setSelection(selection))

        container = document.querySelector('#editor-container') as HTMLElement
        pmDom = view.dom

        // 直接按 heading 层级从 DOM 里找对应标题（比 domAtPos 更可靠）
        const allHeadings = view.dom.querySelectorAll('h1, h2, h3, h4, h5, h6')
        const headingEl = allHeadings[index] as HTMLElement | undefined
        if (headingEl && container) {
          const headingRect = headingEl.getBoundingClientRect()
          const containerRect = container.getBoundingClientRect()
          scrollTarget = headingRect.top - containerRect.top + container.scrollTop
        }
      })

      setTimeout(() => {
        if (scrollTarget > 0 && container) {
          container.scrollTo({ top: scrollTarget, behavior: 'smooth' })
        }
        // 把焦点还给编辑器，preventScroll 阻止浏览器原生 focus-scroll 撤销滚动
        pmDom?.focus({ preventScroll: true })
        controller.setActive(index)
      }, 0)
    }
  }

  return controller
}

/** 计算光标当前所在标题的序号（用于高亮大纲项） */
export function activeHeadingIndex(
  editor: Editor,
  totalHeadings: number
): number | null {
  let result: number | null = null

  editor.action((ctx) => {
    const state = ctx.get(editorViewCtx).state
    const $from = state.selection.$from

    let headingDepth = -1
    for (let depth = $from.depth; depth >= 0; depth--) {
      if ($from.node(depth).type.name === 'heading') {
        headingDepth = depth
        break
      }
    }
    if (headingDepth < 0) return

    // 计算该标题是文档中的第几个 heading
    const headingPos = $from.before(headingDepth)
    let index = 0
    let found = false
    state.doc.descendants((node, pos) => {
      if (found) return false
      if (node.type.name === 'heading') {
        if (pos === headingPos) {
          found = true
          return false
        }
        index++
      }
      return true
    })

    if (found && index < totalHeadings) result = index
  })

  return result
}
