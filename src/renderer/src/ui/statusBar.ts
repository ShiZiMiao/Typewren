import type { Editor } from '@milkdown/kit/core'
import { editorViewCtx } from '@milkdown/kit/core'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'

export interface StatusBarRefs {
  wordCountEl: HTMLElement
  cursorPosEl: HTMLElement
}

/** 统计：中文字符按字计，西文按单词计 */
function countWords(text: string): number {
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []
  const latinWords = text.match(/[A-Za-z0-9][A-Za-z0-9'_-]*/g) ?? []
  return cjk.length + latinWords.length
}

/** 将「文本起点到光标」的前缀换算为 行 / 列（1-based） */
function prefixToLineCol(prefix: string): { line: number; col: number } {
  const lines = prefix.split('\n')
  return { line: lines.length, col: (lines[lines.length - 1] ?? '').length + 1 }
}

let updateTimer: number | undefined

export function updateStatusBar(
  editor: Editor,
  refs: StatusBarRefs,
  sourceState?: { text: string; pos: number } | null
): void {
  // 高频输入时节流，保持状态栏流畅
  window.clearTimeout(updateTimer)
  updateTimer = window.setTimeout(() => {
    let text = ''
    let prefix = ''

    if (sourceState) {
      // 源代码模式：基于 textarea 内容
      text = sourceState.text
      prefix = text.slice(0, sourceState.pos)
    } else {
      // 渲染模式：基于 Milkdown 文档
      editor.action((ctx) => {
        const state = ctx.get(editorViewCtx).state
        const doc = state.doc as ProseNode
        text = doc.textBetween(0, doc.content.size, '\n', '\ufffd')
        prefix = doc.textBetween(0, state.selection.from, '\n', '\ufffd')
      })
    }

    const words = countWords(text)
    const chars = text.replace(/\n/g, '').length

    refs.wordCountEl.textContent =
      words === chars ? `字数 ${words}` : `字数 ${words} · 字符 ${chars}`

    const { line, col } = prefixToLineCol(prefix)
    refs.cursorPosEl.textContent = `行 ${line}，列 ${col}`
  }, 80)
}
