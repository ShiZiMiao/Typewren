import {
  editorViewCtx,
  serializerCtx,
  type Editor
} from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { setBlockType, toggleMark, wrapIn } from '@milkdown/kit/prose/commands'
import type { EditorView } from '@milkdown/kit/prose/view'
import { insert, replaceAll } from '@milkdown/kit/utils'

import { mathBlockSchema, mathInlineSchema } from './math'
import { NodeSelection } from '@milkdown/kit/prose/state'

/* ============================================================
 * 编辑器命令封装：菜单 / 快捷键统一从这里调用
 * 全部基于 ProseMirror 官方 commands + Milkdown insert 宏，
 * 不依赖具体 preset 导出的不稳定 API。
 * ============================================================ */

/** 将当前文档序列化为 Markdown 字符串 */
export function getMarkdown(editor: Editor): string {
  return editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc))
}

/** 用新的 Markdown 内容整体替换文档（打开文件时使用） */
export function setMarkdown(editor: Editor, markdown: string): void {
  editor.action(replaceAll(markdown))
}

function withView(editor: Editor, fn: (view: EditorView) => void): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    fn(view)
    view.focus()
  })
}

/* ---------------- 行内格式 ---------------- */

export function toggleTextMark(editor: Editor, markName: string): void {
  withView(editor, (view) => {
    const markType = view.state.schema.marks[markName]
    if (!markType) return
    toggleMark(markType)(view.state, view.dispatch, view)
  })
}

/* ---------------- 标题与块级转换 ---------------- */

export function setHeadingLevel(editor: Editor, level: number): void {
  withView(editor, (view) => {
    const schema = view.state.schema

    if (level <= 0) {
      setBlockType(schema.nodes.paragraph)(view.state, view.dispatch, view)
      return
    }

    if (schema.nodes.heading) {
      setBlockType(schema.nodes.heading, { level })(
        view.state,
        view.dispatch,
        view
      )
    }
  })
}

export function wrapInListKind(
  editor: Editor,
  kind: 'bullet' | 'ordered'
): void {
  withView(editor, (view) => {
    const schema = view.state.schema
    const listNode =
      kind === 'bullet' ? schema.nodes.bullet_list : schema.nodes.ordered_list
    if (!listNode) return
    wrapIn(listNode)(view.state, view.dispatch, view)
  })
}

export function toggleBlockquote(editor: Editor): void {
  withView(editor, (view) => {
    const blockquote = view.state.schema.nodes.blockquote
    if (!blockquote) return
    wrapIn(blockquote)(view.state, view.dispatch, view)
  })
}

export function makeCodeBlock(editor: Editor): void {
  withView(editor, (view) => {
    const codeBlock = view.state.schema.nodes.code_block
    if (!codeBlock) return
    setBlockType(codeBlock, { language: '' })(view.state, view.dispatch, view)
  })
}

/* ---------------- 插入类 ---------------- */

/** 在光标处插入原始 Markdown 片段（图片粘贴/拖拽等场景复用） */
export function insertMarkdown(editor: Editor, markdown: string): void {
  editor.action(insert(markdown))
  editor.action((ctx) => ctx.get(editorViewCtx).focus())
}

export function insertHr(editor: Editor): void {
  insertMarkdown(editor, '\n---\n')
}

export function insertTable(editor: Editor): void {
  const table = [
    '| 列一 | 列二 | 列三 |',
    '| --- | --- | --- |',
    '| 内容 | 内容 | 内容 |',
    '| 内容 | 内容 | 内容 |',
    ''
  ].join('\n')

  insertMarkdown(editor, table)
}

export function insertTaskItem(editor: Editor): void {
  insertMarkdown(editor, '\n- [ ] 任务\n')
}

/**
 * 在光标处插入一个可选中的原子节点（公式用），并立即进入其源码编辑状态。
 * replaceSelectionWith 对可选择的原子节点会自动产生 NodeSelection；
 * 兜底分支对 selection.from - node.nodeSize 做下限钳制，防止插入位置在文档开头时算负。
 */
function insertMathNode(
  editor: Editor,
  createNode: (ctx: Ctx) => ProseNode | null
): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    const node = createNode(ctx)
    if (!node) return

    const tr = view.state.tr.replaceSelectionWith(node)
    if (!(tr.selection instanceof NodeSelection)) {
      const pos = Math.max(0, tr.selection.from - node.nodeSize)
      tr.setSelection(NodeSelection.create(tr.doc, pos))
    }
    view.dispatch(tr)
  })
  editor.action((ctx) => ctx.get(editorViewCtx).focus())
}

/** 插入空块级公式并立即进入源码编辑状态 */
export function insertMathBlock(editor: Editor): void {
  insertMathNode(editor, (ctx) =>
    mathBlockSchema.type(ctx).create({ value: '' })
  )
}

export async function insertOrUpdateLink(editor: Editor): Promise<void> {
  const href = window.prompt('链接地址：', 'https://')
  if (!href) return

  let selectionEmpty = true
  editor.action((ctx) => {
    selectionEmpty = ctx.get(editorViewCtx).state.selection.empty
  })

  if (selectionEmpty) {
    const text = window.prompt('链接文字：', '链接') ?? ''
    if (text.trim().length === 0) return
    insertMarkdown(editor, `[${text}](${href})`)
    return
  }

  withView(editor, (view) => {
    const linkType = view.state.schema.marks.link
    if (!linkType) return
    toggleMark(linkType, { href })(view.state, view.dispatch, view)
  })
}

export async function insertImage(editor: Editor): Promise<void> {
  const src = window.prompt('图片地址：', 'https://')
  if (!src || src === 'https://') return

  const alt = window.prompt('替代文字（可选）：', '') ?? ''
  insertMarkdown(editor, `![${alt}](${src})`)
}

/** 在光标处插入一个行内公式节点 */
export function insertMathInline(editor: Editor): void {
  insertMathNode(editor, (ctx) =>
    mathInlineSchema.type(ctx).create({ value: '' })
  )
}
