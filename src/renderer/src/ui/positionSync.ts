import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx } from '@milkdown/kit/core';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';

import { screenPxToLocal } from './zoom';

/* ============================================================
 * 渲染 ↔ 源码视图的位置同步
 *
 * 动机：切换视图时用户希望光标/视口停在文档的**同一处**。
 * 两侧没有可逆的逐字符映射（渲染文本 ≠ Markdown 源码），
 * 故采用"文本匹配 + 比例兜底"两级策略：
 *   1) 剥离 Markdown 标记后的块/行文本匹配（精确/包含两档打分，最常见也最准）；
 *   2) 按块序号/行号比例落点（编辑造成失配时的兜底，保证总有目标）。
 * ============================================================ */

/**
 * 剥离行首结构符（# 标题 / - 列表 / > 引用 / ``` 代码）与行内 Markdown 语法壳，
 * 与 PM textContent 对齐（源码/渲染两侧匹配对比的统一口径）。
 * 只删**成对出现**的行内语法符（链接壳 / 转义 / 反引号 / **、*、~~、__），
 * 不全局删 `_`/`*`——词内下划线（fused_b、pure_t3、conf_mh）是纯文本，
 * CommonMark 不视为强调，PM textContent 会原样保留；全局删会导致
 * "源码侧剥过 ≠ PM 侧保留"，源码模式大纲/切换定位失效。
 * 注意：**不剥行首数字序号**（`1. ` / `5.1 `）——章节号标题在 PM 侧保留
 * 数字，源码侧也必须保留，否则"5.1 conf_mh"这类标题匹配失效。
 */
export function stripMarkup(line: string): string {
  return line
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|>\s*|(?:```|~~~)\S*)/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\\([\\`*_[\]{}~#])/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .trim();
}

export interface SourceLine {
  start: number;
  content: string;
}

/** 源码文本按行切分（保留每行的源码偏移） */
export function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lines.push({ start, content: text.slice(start, i) });
      start = i + 1;
    }
  }
  lines.push({ start, content: text.slice(start) });
  return lines;
}

/** 字符偏移 → 行号（越界归入首/尾行） */
export function lineAt(lines: SourceLine[], caret: number): number {
  if (lines.length === 0) return 0;
  let idx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].start <= caret) idx = i;
    else break;
  }
  return idx;
}

/** 把字符偏移换算为源码区内的光标 [{node, offset}]（contenteditable 可能被高亮拆成多文本节点） */
function locateCaretNode(
  el: HTMLElement,
  caret: number
): { startNode: Text; startOffset: number } | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let acc = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (caret <= acc + node.data.length) {
      return { startNode: node, startOffset: Math.min(caret - acc, node.data.length) };
    }
    acc += node.data.length;
  }
  return null;
}

/** 只设光标不滚动；返回是否成功（el 可能是分解高亮的 contenteditable） */
export function setSourceCaret(el: HTMLElement, caret: number): boolean {
  const hit = locateCaretNode(el, caret);
  if (!hit) return false;
  const selection = window.getSelection();
  if (!selection) return false;

  const range = document.createRange();
  range.setStart(hit.startNode, hit.startOffset);
  range.collapse(true);

  // 焦点放回源码区后再设选区（contenteditable focus 可能清空选区）
  selection.removeAllRanges();
  selection.addRange(range);
  if (document.activeElement !== el) {
    el.focus();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return true;
}

/**
 * 在源码视图定位到字符偏移：光标放点 + 滚动到视口。
 * el 为 contenteditable 源码区（可能被高亮拆成多个文本节点，需逐段累计定位）。
 * align 控制滚动对齐方式（top 与渲染模式跳转一致）；
 * behavior 控制滚动动画——视图切换要瞬时（auto），用户主动跳转（大纲）可平滑。
 */
export function placeSourceCaret(
  el: HTMLElement,
  caret: number,
  align: 'top' | 'center' = 'top',
  behavior: ScrollBehavior = 'smooth'
): boolean {
  if (!setSourceCaret(el, caret)) return false;
  scrollSourceCaretIntoView(el, align, behavior);
  return true;
}

/** 计算并滚动源码视区使光标落点对齐（纯滚动，不改光标） */
function scrollSourceCaretIntoView(
  el: HTMLElement,
  align: 'top' | 'center' = 'top',
  behavior: ScrollBehavior = 'smooth'
): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  const containerRect = el.getBoundingClientRect();
  if (containerRect.height > 0 && rect.height > 0) {
    // rect 差值是屏幕像素（zoom 子树内 ×zoom），scrollTop 是局部单位——
    // 必须 ÷zoom 换算再相加（zoom≠100% 时旧公式偏移 zoom 倍）；
    // 容器高度用 clientHeight（恒为局部单位），不再混入 rect 的屏幕像素
    const local = (screenPx: number): number => screenPxToLocal(el, screenPx);
    const target =
      align === 'center'
        ? el.scrollTop + local(rect.top - containerRect.top) - el.clientHeight / 2 + local(rect.height) / 2
        : el.scrollTop + local(rect.top - containerRect.top);
    el.scrollTo({ top: Math.max(0, target), behavior });
  }
}

/** 退出源码模式时记录的锚点（光标行文本 + 行号比例） */
export interface SourceExitAnchor {
  lineText: string;
  lineIndex: number;
  lineCount: number;
}

/** 进入源码模式时捕获的渲染侧锚点（光标所在块） */
export interface EditorAnchor {
  /** 光标所在 textblock 的纯文本（depth-0 选区无 textblock 祖先时为空串） */
  blockText: string;
  /** 光标所在顶层块序号 / 块总数（比例兜底） */
  blockIndex: number;
  blockCount: number;
}

/** 从 PM 编辑器捕获当前光标锚点 */
export function captureEditorAnchor(editor: Editor): EditorAnchor {
  const state = editor.action((ctx) => ctx.get(editorViewCtx).state);
  const $from = state.selection.$from;

  // depth 0 = NodeSelection 顶到文档层（点选图片 / 整表 / TOC 跳转后）：
  // 没有 textblock 祖先，parent 是 doc（textContent 变全文）、start(1) 越界
  // 得 undefined（块序号算成 NaN 全灭）——块文本锚点只在 depth≥1 时有意义，
  // depth 0 留空走比例兜底；块序号改用 $from.pos（选中节点前的边界）依旧可算。
  const blockText = $from.depth >= 1 ? $from.parent.textContent : '';
  const blockStart = $from.depth >= 1 ? $from.start(1) : $from.pos;

  let blockIndex = 0;
  let counted = 0;
  state.doc.forEach((node, offset) => {
    if (offset <= blockStart && blockStart < offset + node.nodeSize) {
      blockIndex = counted;
    }
    counted++;
  });

  return {
    blockText,
    blockIndex,
    blockCount: state.doc.childCount
  };
}

/** 渲染锚点 → 源码文本中的字符偏移（匹配失败用比例兜底） */
export function anchorToSourceCaret(text: string, anchor: EditorAnchor): number {
  const lines = sourceLines(text);
  if (anchor.blockCount === 0) return 0;

  // 1) 行文本匹配：光标块首行剥离标记后的片段，找包含它的源码行
  const needle = stripMarkup(anchor.blockText.slice(0, 32));
  if (needle.length >= 4) {
    for (let i = 0; i < lines.length; i++) {
      if (!stripMarkup(lines[i].content)) continue;
      if (stripMarkup(lines[i].content).includes(needle)) {
        // 行内落点：优先锚点原样出现的位置，否则行首
        const rawHit = lines[i].content.indexOf(anchor.blockText.trim().slice(0, 12));
        return lines[i].start + (rawHit >= 0 ? rawHit : 0);
      }
    }
  }

  // 2) 比例兜底：块序号 → 行号
  const ratio = anchor.blockIndex / anchor.blockCount;
  const lineIdx = Math.min(lines.length - 1, Math.round(ratio * (lines.length - 1)));
  return lines[lineIdx].start;
}

/**
 * 源码锚点 → 渲染侧光标：按文本匹配 textblock，
 * 优先级 相等 > 包含 > 行比例兜底；dispatch selection 并滚动到可见。
 */
export function placeEditorCursor(editor: Editor, anchor: SourceExitAnchor): void {
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  const { state } = view;
  const needle = stripMarkup(anchor.lineText);

  interface Candidate {
    pos: number;
    inner: number;
    score: number;
  }
  let best: Candidate | null = null;
  const textblockPos: number[] = [];

  state.doc.descendants((node: ProseNode, pos: number) => {
    if (!node.isTextblock) return;
    textblockPos.push(pos + 1);
    const text = stripMarkup(node.textContent);
    if (!text || !needle) return;
    let score = 0;
    if (text === needle) score = 3;
    else if (text.includes(needle)) score = 2;
    else if (needle.length >= 4 && needle.includes(text)) score = 1;
    if (score > 0 && (best === null || score > best.score)) {
      // 行内落点：在**原始 textContent** 上找 needle 的字符偏移——text 是剥离
      // 标记后的副本，其 indexOf 是"剥离坐标"，块内含被剥掉的语法壳时整体错位
      // （旧实现把剥离索引当原始偏移用）。needle 只存在于剥离视图时落块首。
      const inner = node.textContent.indexOf(needle);
      best = { pos: pos + 1, inner: inner >= 0 ? inner : 0, score };
    }
  });

  if (best === null) {
    // 编辑造成失配：按行级比例选 textblock（保证总有落点）
    if (textblockPos.length === 0) return;
    const ratio = anchor.lineCount > 0 ? anchor.lineIndex / anchor.lineCount : 0;
    const idx = Math.min(textblockPos.length - 1, Math.round(ratio * (textblockPos.length - 1)));
    best = { pos: textblockPos[idx], inner: 0, score: 0 };
  }

  // pos 是 textblock 内容起点；inner 不得超过块内长度（= content.size），
  // TextSelection.create 会对越界落点就近收敛
  const maxInner = state.doc.resolve(best.pos).parent.content.size;
  const sel = TextSelection.create(state.doc, best.pos + Math.min(best.inner, maxInner));
  view.dispatch(state.tr.setSelection(sel).scrollIntoView());
  // 切回渲染后把焦点还给编辑器（PM 只在聚焦时同步 DOM 选区/光标）
  view.focus();
}
