import { isSafeLinkHref } from '../util/link';

/* ============================================================
 * 原始 HTML 净化器（全编辑器唯一入口）
 * rawHtml.ts（html 节点视图）、quiz.ts（答案解析）等共用：
 * - DOMParser 先行（innerHTML 直插不经过此层）；
 * - 白名单标签克隆 + 属性剥离（事件属性与 style 一律丢弃，
 *   a 走 isSafeLinkHref 同「插入链接」口径）；
 * - script/style 隐藏（站点构建期源码，执行即 XSS）；其余危险
 *   标签（iframe/embed/表单 等）只留文本内容；
 * - 未知标签（Vue 组件等）无法安全渲染，整块以原文文本保留；
 * - 仅闭合/空白内容 → 空（调用方隐藏）。
 * 通用性红线：任何"渲染 HTML"的功能必须引用本模块，不得另起
 * 一套净化逻辑（防 XSS 口径漂移）。
 * ============================================================ */

/** 允许真渲染的标签（无事件/脚本语义的展示型标签） */
const ALLOWED_TAGS = new Set([
  'details',
  'summary',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'del',
  'ins',
  'br',
  'ul',
  'ol',
  'li',
  'a',
  'code',
  'pre',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'colgroup',
  'col',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'blockquote',
  'hr',
  'small',
  'mark',
  'abbr',
  'sub',
  'sup',
  'kbd',
  'cite',
  'center',
  'dl',
  'dt',
  'dd',
  'figure',
  'figcaption',
  'img',
  'span',
  'div'
]);

/** 危险标签：不执行、不展示标签自身（script/style 全隐藏；其余只留文本内容） */
const DANGEROUS_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'form',
  'input',
  'textarea',
  'button',
  'select',
  'option',
  'optgroup',
  'link',
  'meta',
  'base',
  'noscript',
  'template',
  'slot',
  'video',
  'audio',
  'source',
  'track',
  'svg',
  'math',
  'canvas',
  'applet',
  'marquee',
  'portal'
]);

/** 允许保留的属性（其余一律剥离，事件属性与 style 在 sanitizeTree 中先行剔除） */
const ALLOWED_ATTRS = new Set([
  'class',
  'id',
  'title',
  'colspan',
  'rowspan',
  'width',
  'height',
  'align',
  'border',
  'cellpadding',
  'cellspacing',
  'open',
  'start',
  'value',
  'datetime',
  'lang',
  'dir',
  'name',
  'scope'
]);

export type SanitizeResult =
  | { kind: 'empty' } // script/style 整块（浏览器隐藏）/仅闭合标签等 → 隐藏
  | { kind: 'html'; fragment: DocumentFragment }; // 净化后真渲染

/** 递归净化：白名单标签克隆（属性剥离），危险/未知标签降级为文本 */
function sanitizeTree(
  node: Node,
  out: Node,
  doc: Document,
  resolveImgSrc?: (src: string) => string
): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    // 源 HTML 的格式化空白（li 间缩进、标签间换行）在编辑器 pre-wrap
    // 下会被渲染成可见的大空隙——纯空白文本节点直接丢弃
    if (text.trim().length === 0) return;
    out.appendChild(doc.createTextNode(text));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  if (DANGEROUS_TAGS.has(tag)) {
    // script/style 按浏览器行为隐藏（站点构建期源码）；其余危险标签
    // （iframe/embed/表单 等）只留文本内容，不执行不落交互 DOM
    if (tag === 'script' || tag === 'style') return;
    out.appendChild(doc.createTextNode(el.textContent ?? ''));
    return;
  }
  if (!ALLOWED_TAGS.has(tag)) {
    // 未知标签（Vue 组件等）无法安全渲染，整体以原文文本保留
    out.appendChild(doc.createTextNode(el.outerHTML ?? ''));
    return;
  }

  const clone = doc.createElement(tag);
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith('on') || name === 'style') continue;
    if (tag === 'a' && name === 'href') {
      // 链接协议白名单（与「插入链接」同口径：http/https/mailto/相对路径）
      if (isSafeLinkHref(attr.value)) clone.setAttribute('href', attr.value);
      continue;
    }
    if (!ALLOWED_ATTRS.has(name) && name !== 'src') continue;
    clone.setAttribute(name, attr.value);
  }
  // 本地相对图片（./assets/…）经文档目录解析（与 imageView 同一口径）
  if (tag === 'img' && resolveImgSrc) {
    const src = clone.getAttribute('src');
    if (src) clone.setAttribute('src', resolveImgSrc(src));
  }
  for (const child of Array.from(el.childNodes)) sanitizeTree(child, clone, doc, resolveImgSrc);
  out.appendChild(clone);
}

/**
 * 解析 + 净化一段原始 HTML（DOMParser 先行，避免 innerHTML 直插被执行）。
 * 注意：script/style 是 HTML 解析的 head 元素——整段以它们开头时会被
 * 放进 document.head 而非 body，必须两个容器一起看（否则误判为空）。
 */
export function sanitizeHtml(
  value: string,
  resolveImgSrc?: (src: string) => string
): SanitizeResult {
  const doc = new DOMParser().parseFromString(value, 'text/html');
  const head = doc.head;
  const body = doc.body;
  const elements = Array.from(head.children).concat(Array.from(body.children));

  // 代码型：整块仅 script/style（micromark HTML 块类型 1 的典型形态）→
  // 浏览器行为：站点构建期源码不渲染（内容进源码模式可见）
  if (
    elements.length > 0 &&
    elements.every((el) => el.tagName === 'SCRIPT' || el.tagName === 'STYLE')
  ) {
    return { kind: 'empty' };
  }

  // 全未知标签（Vue 组件等无法安全渲染）：整块以原文文本保留——
  // 不经标量子树（HTML 解析会把 <InteractiveQuiz /> 小写化成闭合标签形）
  if (
    elements.length > 0 &&
    elements.every(
      (el) =>
        !ALLOWED_TAGS.has(el.tagName.toLowerCase()) && !DANGEROUS_TAGS.has(el.tagName.toLowerCase())
    )
  ) {
    const fragment = doc.createDocumentFragment();
    fragment.appendChild(doc.createTextNode(value));
    return { kind: 'html', fragment };
  }

  const fragment = doc.createDocumentFragment();
  for (const child of Array.from(head.childNodes).concat(Array.from(body.childNodes))) {
    sanitizeTree(child, fragment, doc, resolveImgSrc);
  }
  const text = fragment.textContent ?? '';
  if (fragment.childNodes.length === 0 || text.trim().length === 0) {
    return { kind: 'empty' };
  }
  return { kind: 'html', fragment };
}
