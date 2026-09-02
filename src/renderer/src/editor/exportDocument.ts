import katex from 'katex'
import hljs from 'highlight.js/lib/common'
import { parserCtx, type Editor } from '@milkdown/kit/core'
import {
  DOMSerializer,
  type Node as ProseNode
} from '@milkdown/kit/prose/model'

import type { FileService } from '@/services/fileService'
import { currentTheme } from '@/ui/theme'

import variablesCss from '../styles/variables.css?raw'
import editorCss from '../styles/editor.css?raw'
import exportCss from '../styles/export.css?raw'
import katexCss from 'katex/dist/katex.min.css?raw'

/* ============================================================
 * 导出为 PDF / HTML
 * 与编辑器同源的渲染链路：把当前 Markdown 重新走一遍 Milkdown
 * parser（普通文本 → PM 文档），再用 ProseMirror DOMSerializer 按
 * 各节点 toDOM 序列化为 HTML——骨架与编辑器所见完全一致；
 * 公式（KaTeX）与代码高亮（highlight.js）以两段轻量后处理补齐，
 * CSS 直接内联编辑器同款 variables.css + editor.css。
 * ============================================================ */

export type ExportKind = 'pdf' | 'html'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 渲染 KaTeX；出错时输出错误提示而非中断导出 */
function renderMath(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      strict: false,
      output: 'html'
    })
  } catch (error) {
    return `<span class="typewren-math-error">${escapeHtml(
      String(error)
    )}</span>`
  }
}

/** 行内公式 / 块级公式：把序列化出的占位节点换成 KaTeX 渲染结果 */
function renderFragmentMath(root: HTMLElement): void {
  root.querySelectorAll('.typewren-math-block').forEach((el) => {
    const latex = (el as HTMLElement).getAttribute('data-math-value') ?? ''
    const rendered = document.createElement('div')
    rendered.className = 'math-rendered'
    rendered.innerHTML = renderMath(latex, true)
    el.replaceChildren(rendered)
  })
  root.querySelectorAll('.typewren-math-inline').forEach((el) => {
    const latex = (el as HTMLElement).getAttribute('data-inline-math') ?? ''
    el.innerHTML = renderMath(latex, false)
  })
}

/** 代码块着色：优先按 data-language，未注册语言降级自动检测 */
function highlightCode(code: string, language: string): string {
  try {
    if (hljs.getLanguage(language)) {
      return hljs.highlight(code, { language }).value
    }
  } catch {
    // 落入自动检测分支
  }
  try {
    return hljs.highlightAuto(code).value
  } catch {
    return escapeHtml(code)
  }
}

function highlightCodeBlocks(root: HTMLElement): void {
  root.querySelectorAll<HTMLPreElement>('pre[data-language]').forEach((pre) => {
    const codeEl = pre.querySelector('code')
    if (!codeEl) return
    const language = pre.dataset.language ?? ''
    codeEl.innerHTML = highlightCode(codeEl.textContent ?? '', language)
  })
}

/** 把表格包进 .table-scroll-wrapper，与编辑器的横向滚动行为一致（打印时由 CSS 覆盖） */
function wrapTables(root: HTMLElement): void {
  root.querySelectorAll('table').forEach((table) => {
    const wrapped = document.createElement('div')
    wrapped.className = 'table-scroll-wrapper'
    table.replaceWith(wrapped)
    wrapped.appendChild(table)
  })
}

/** 把 Markdown 走编辑器 parser 渲染为导出用的 HTML 文档字符串 */
export function buildExportHtml(
  editor: Editor,
  markdown: string,
  title: string
): string {
  const doc: ProseNode = editor.action((ctx) => ctx.get(parserCtx)(markdown))

  const content = document.createElement('div')
  content.appendChild(
    DOMSerializer.fromSchema(doc.type.schema).serializeFragment(doc.content)
  )
  renderFragmentMath(content)
  highlightCodeBlocks(content)
  wrapTables(content)

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${currentTheme()}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${variablesCss}
${editorCss}
${exportCss}
${katexCss}
</style>
</head>
<body>
<main class="export-root">
<div class="ProseMirror">${content.innerHTML}</div>
</main>
</body>
</html>`
}

/** 移除扩展名得到文档基础名（作为导出默认文件名） */
function baseNameWithoutExtension(fileName: string): string {
  return fileName.replace(/\.(md|markdown|mdown)$/i, '')
}

/**
 * 导出入口：装配完整 HTML 并交给主进程写盘 / 打印。
 * 失败与取消由主进程对话框与错误框兜底，这里不重复提示。
 */
export async function exportDocument(
  editor: Editor,
  fileService: FileService,
  kind: ExportKind
): Promise<void> {
  const base = baseNameWithoutExtension(fileService.fileName)
  const html = buildExportHtml(editor, fileService.currentMarkdown, base)
  await window.typewren.exportDocument({
    kind,
    html,
    suggestedName: `${base}.${kind}`
  })
}