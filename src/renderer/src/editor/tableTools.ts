import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import {
  addColumnAfter,
  addColumnBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  addRowAfter,
  addRowBefore
} from '@milkdown/kit/prose/tables'
import { $prose } from '@milkdown/kit/utils'

/* ============================================================
 * 表格可视化编辑工具条：
 * 光标位于表格内时，在表格上方浮现行列操作按钮。
 * 纯 DOM 实现（无框架依赖），命令来自 prosemirror-tables。
 * ============================================================ */

interface ToolButtonDef {
  label: string
  title: string
  command: (
    state: EditorView['state'],
    dispatch: EditorView['dispatch'] | undefined,
    view: EditorView
  ) => boolean
  danger?: boolean
}

const BUTTONS: (ToolButtonDef | 'sep')[] = [
  { label: '↑ 行', title: '在上方插入行', command: addRowBefore },
  { label: '↓ 行', title: '在下方插入行', command: addRowAfter },
  { label: '← 列', title: '在左侧插入列', command: addColumnBefore },
  { label: '→ 列', title: '在右侧插入列', command: addColumnAfter },
  'sep',
  {
    label: '✂ 行',
    title: '删除当前行',
    command: deleteRow,
    danger: true
  },
  {
    label: '✂ 列',
    title: '删除当前列',
    command: deleteColumn,
    danger: true
  },
  'sep',
  {
    label: '✕ 表格',
    title: '删除整个表格',
    command: deleteTable,
    danger: true
  }
]

let toolbarEl: HTMLElement | null = null
let activeView: EditorView | null = null

function findTablePos(view: EditorView): number | null {
  const $from = view.state.selection.$from
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (node.type.name === 'table') return $from.before(depth)
  }
  return null
}

function ensureToolbar(): HTMLElement {
  if (toolbarEl && toolbarEl.isConnected) return toolbarEl

  const bar = document.createElement('div')
  bar.id = 'typewren-table-tools'

  const runCommand =
    (command: ToolButtonDef['command']) =>
    (event: Event): void => {
      event.preventDefault()
      const view = activeView
      if (!view || view.isDestroyed) return

      // 仅当光标仍在表格内时执行，避免按钮残留导致的误操作
      if (findTablePos(view) === null) {
        hide()
        return
      }

      command(view.state, view.dispatch, view)
      view.focus()
      sync(view)
    }

  for (const def of BUTTONS) {
    if (def === 'sep') {
      const sep = document.createElement('span')
      sep.className = 'tt-sep'
      bar.appendChild(sep)
      continue
    }

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = def.label
    btn.title = def.title
    if (def.danger) btn.classList.add('danger')
    btn.addEventListener('pointerdown', runCommand(def.command))
    bar.appendChild(btn)
  }

  document.body.appendChild(bar)
  toolbarEl = bar
  return bar
}

function positionToolbar(view: EditorView, tablePos: number): void {
  const tableDom = view.nodeDOM(tablePos) as HTMLElement | null
  if (!tableDom || !toolbarEl) return

  const rect = tableDom.getBoundingClientRect()
  const barRect = toolbarEl.getBoundingClientRect()

  let top = rect.top - barRect.height - 8
  if (top < 6) top = rect.bottom + 8

  let left = rect.left
  const maxLeft = window.innerWidth - barRect.width - 12
  if (left > maxLeft) left = Math.max(8, maxLeft)

  toolbarEl.style.top = `${Math.round(top)}px`
  toolbarEl.style.left = `${Math.round(left)}px`
}

function sync(view: EditorView): void {
  const tablePos =
    view.dom.offsetParent === null ? null : findTablePos(view)

  if (tablePos === null || !view.dom.isConnected) {
    hide()
    return
  }

  ensureToolbar().classList.add('visible')
  positionToolbar(view, tablePos)
}

function hide(): void {
  toolbarEl?.classList.remove('visible')
}

export const tableTools = $prose(() => {
  return new Plugin({
    view(editorView: EditorView) {
      activeView = editorView

      const onReposition = (): void => {
        if (activeView && !activeView.isDestroyed && toolbarEl?.classList.contains('visible')) {
          const pos = findTablePos(activeView)
          if (pos !== null) positionToolbar(activeView, pos)
          else hide()
        }
      }

      // 为表格添加滚动包装器，并根据宽度决定是否换行
      const wrapExistingTables = (): void => {
        const tables = editorView.dom.querySelectorAll('table')
        tables.forEach((table) => {
          if (table.parentElement?.classList.contains('table-scroll-wrapper')) {
            // 已包装，更新换行策略
            updateTableWrap(table as HTMLTableElement, table.parentElement as HTMLElement)
            return
          }
          const wrapper = document.createElement('div')
          wrapper.className = 'table-scroll-wrapper'
          table.parentNode?.insertBefore(wrapper, table)
          wrapper.appendChild(table)
          updateTableWrap(table as HTMLTableElement, wrapper)
        })
      }

      const updateTableWrap = (table: HTMLTableElement, wrapper: HTMLElement): void => {
        const containerWidth = editorView.dom.clientWidth - 40 // 减去 padding
        const tableWidth = table.scrollWidth

        if (tableWidth > containerWidth * 1.5) {
          // 超出1.5倍，使用滚动
          wrapper.classList.remove('table-wrap-mode')
          wrapper.classList.add('table-scroll-mode')
        } else {
          // 否则换行显示
          wrapper.classList.remove('table-scroll-mode')
          wrapper.classList.add('table-wrap-mode')
        }
      }

      window.addEventListener('resize', onReposition)
      window.addEventListener('scroll', onReposition, true)

      // 延迟执行，确保 DOM 已经渲染完成
      requestAnimationFrame(() => {
        wrapExistingTables()
        sync(editorView)
      })

      return {
        update(view: EditorView): void {
          activeView = view
          sync(view)
        },
        destroy(): void {
          window.removeEventListener('resize', onReposition)
          window.removeEventListener('scroll', onReposition, true)
          hide()
          activeView = null
        }
      }
    }
  })
})
