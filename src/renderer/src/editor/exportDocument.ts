import hljs from 'highlight.js/lib/common';
import { parserCtx, type Editor } from '@milkdown/kit/core';
import { DOMSerializer, type Node as ProseNode } from '@milkdown/kit/prose/model';

import type { FileService } from '@/services/fileService';
import { dirnamePath } from '@/services/imagePasteService';
import { currentTheme } from '@/ui/theme';
import { escapeHtml } from '@/util/escape';
import { isSafeLinkHref } from '@/util/link';
import { resolveImageSrc } from '../../../shared/imageUrl';
import { renderMermaidSvg } from './mermaid';
import { renderMath } from './math';
import { decodeImageRef } from './imageView';
import { fillExportToc } from './toc';
import { buildDocxDoc } from './docxExport';

import variablesCss from '../styles/variables.css?raw';
import editorCss from '../styles/editor.css?raw';
import exportCss from '../styles/export.css?raw';
import katexCss from 'katex/dist/katex.min.css?raw';

/* ============================================================
 * 导出为 PDF / HTML
 * 与编辑器同源的渲染链路：把当前 Markdown 重新走一遍 Milkdown
 * parser（普通文本 → PM 文档），再用 ProseMirror DOMSerializer 按
 * 各节点 toDOM 序列化为 HTML——骨架与编辑器所见完全一致；
 * 公式（KaTeX）与代码高亮（highlight.js）以两段轻量后处理补齐，
 * CSS 直接内联编辑器同款 variables.css + editor.css。
 * 本地图片 src 导出前统一改写为 typewren-img://（resolveExportImages）：
 * 导出 HTML 的基址是临时目录（PDF/PNG 由主进程隐藏窗口 loadFile 加载），
 * 文档相对引用 ./assets/… 必然 404——与编辑器显示同一套 resolveImageSrc 解析。
 * ============================================================ */

export type ExportKind = 'pdf' | 'html' | 'docx' | 'png';

/** 行内公式 / 块级公式：把序列化出的占位节点换成 KaTeX 渲染结果 */
function renderFragmentMath(root: HTMLElement): void {
  root.querySelectorAll('.typewren-math-block').forEach((el) => {
    const latex = (el as HTMLElement).getAttribute('data-math-value') ?? '';
    const rendered = document.createElement('div');
    rendered.className = 'math-rendered';
    rendered.innerHTML = renderMath(latex, true);
    el.replaceChildren(rendered);
  });
  root.querySelectorAll('.typewren-math-inline').forEach((el) => {
    const latex = (el as HTMLElement).getAttribute('data-inline-math') ?? '';
    el.innerHTML = renderMath(latex, false);
  });
}

/** Mermaid 图表：把占位节点换成 SVG（渲染是异步的，与导出装配顺序配合） */
async function renderFragmentMermaid(root: HTMLElement): Promise<void> {
  const blocks = root.querySelectorAll<HTMLElement>('.typewren-mermaid-block');
  await Promise.all(
    Array.from(blocks).map(async (el) => {
      const code = el.getAttribute('data-mermaid-value') ?? '';
      const rendered = document.createElement('div');
      rendered.className = 'mermaid-rendered';
      try {
        rendered.innerHTML = await renderMermaidSvg(code);
      } catch (error) {
        rendered.innerHTML = `<div class="typewren-math-error">${escapeHtml(String(error))}</div>`;
      }
      el.replaceChildren(rendered);
    })
  );
}

/** 代码块着色：优先按 data-language，未注册语言降级自动检测 */
function highlightCode(code: string, language: string): string {
  try {
    if (hljs.getLanguage(language)) {
      return hljs.highlight(code, { language }).value;
    }
  } catch {
    // 落入自动检测分支
  }
  try {
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

function highlightCodeBlocks(root: HTMLElement): void {
  root.querySelectorAll<HTMLPreElement>('pre[data-language]').forEach((pre) => {
    const codeEl = pre.querySelector('code');
    if (!codeEl) return;
    const language = pre.dataset.language ?? '';
    codeEl.innerHTML = highlightCode(codeEl.textContent ?? '', language);
  });
}

/** 把表格包进 .table-scroll-wrapper，与编辑器的横向滚动行为一致（打印时由 CSS 覆盖） */
function wrapTables(root: HTMLElement): void {
  root.querySelectorAll('table').forEach((table) => {
    const wrapped = document.createElement('div');
    wrapped.className = 'table-scroll-wrapper';
    table.replaceWith(wrapped);
    wrapped.appendChild(table);
  });
}

/**
 * 解除非白名单协议的链接 href（javascript:/data: 等会活进导出文件）。
 * 编辑器内 ProseMirror 会拦截点击，但导出的 HTML 是用户拿去浏览器打开的，
 * 链接协议必须在导出前消毒（http/https/mailto 与相对路径保留）。
 */
function sanitizeLinks(root: HTMLElement): void {
  root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
    const href = a.getAttribute('href') ?? '';
    if (!isSafeLinkHref(href)) a.removeAttribute('href');
  });
}

/**
 * 本地图片 src 改写为可加载 URL（与编辑器 imageView 同一 resolveImageSrc 口径）。
 * 导出 HTML 落在临时目录再被隐藏窗口 loadFile（PDF/PNG），文档里的相对引用
 * ./assets/… 以临时目录为基址必然 404（图片其实就在文档旁边）。
 * - 本地引用（相对/绝对路径）→ typewren-img://local/…（协议全局注册，隐藏窗可用）；
 * - 非本地 URL（http/https/data 等已带 scheme）resolveImageSrc 原样返回，不动；
 * - 用 setAttribute 写回原始属性值：走 img.src 属性赋值会被浏览器按页面基址
 *   再解析一次（/x.png → 临时目录绝对路径），必须保持字面值。
 */
function resolveExportImages(root: HTMLElement, docDir: string | null): void {
  root.querySelectorAll<HTMLImageElement>('img[src]').forEach((img) => {
    const raw = img.getAttribute('src') ?? '';
    // 先撤销引用侧百分号编码（与编辑器 imageView 同口径），再解析
    img.setAttribute('src', resolveImageSrc(decodeImageRef(raw), docDir));
  });
}

/** 把 Markdown 走编辑器 parser 渲染为导出用的 HTML 文档字符串 */
export async function buildExportHtml(
  editor: Editor,
  markdown: string,
  title: string,
  docDir: string | null
): Promise<string> {
  const doc: ProseNode = editor.action((ctx) => ctx.get(parserCtx)(markdown));

  const content = document.createElement('div');
  content.appendChild(DOMSerializer.fromSchema(doc.type.schema).serializeFragment(doc.content));
  renderFragmentMath(content);
  await renderFragmentMermaid(content);
  fillExportToc(content, doc);
  highlightCodeBlocks(content);
  wrapTables(content);
  // 图片解析与链接消毒互不影响（后者只动 a[href]），顺序随意但同批收口
  resolveExportImages(content, docDir);
  sanitizeLinks(content);

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
</html>`;
}

/** 移除扩展名得到文档基础名（作为导出默认文件名） */
function baseNameWithoutExtension(fileName: string): string {
  return fileName.replace(/\.(md|markdown|mdown)$/i, '');
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
  const base = baseNameWithoutExtension(fileService.fileName);
  const suggestedName = `${base}.${kind}`;

  if (kind === 'docx') {
    const docxDoc = buildDocxDoc(editor, fileService.currentMarkdown);
    await window.typewren.exportDocument({
      kind,
      html: '',
      suggestedName,
      docxBlocks: docxDoc.blocks
    });
    return;
  }

  const html = await buildExportHtml(
    editor,
    fileService.currentMarkdown,
    base,
    docDirOf(fileService)
  );
  await window.typewren.exportDocument({
    kind,
    html,
    suggestedName
  });
}

/** 文档目录（图片相对引用的解析基准）；未保存文档无从解析 → null 原样透传 */
function docDirOf(fileService: FileService): string | null {
  const path = fileService.getFilePath();
  return path ? dirnamePath(path) : null;
}
