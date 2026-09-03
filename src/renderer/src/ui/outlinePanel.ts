import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/kit/prose/state';

/** 滚动联动阈值：标题行顶距视口顶 8px 内视为“位于顶部” */
const SCROLL_ACTIVE_THRESHOLD_PX = 8;

export interface OutlineEntry {
  level: number;
  text: string;
  /** 标题在文档中的序号（用于点击时重新定位） */
  index: number;
}

export interface OutlinePanelDeps {
  /** 当前是否处于源码模式（决定跳转目标：渲染视图 / 源码文本行） */
  isSourceMode(): boolean;
  /** 源码编辑区元素（源码模式跳转用） */
  sourceEl(): HTMLElement | null;
}

/** 从当前文档收集全部标题（含位置信息） */
function collectHeadings(editor: Editor): (OutlineEntry & { pos: number })[] {
  const entries: (OutlineEntry & { pos: number })[] = [];

  editor.action((ctx) => {
    const doc = ctx.get(editorViewCtx).state.doc;

    doc.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        entries.push({
          level: Number(node.attrs.level),
          text: node.textContent.trim() || `标题 ${entries.length + 1}`,
          pos,
          index: entries.length
        });
      }
      return true;
    });
  });

  return entries;
}

/** 剥离行内 Markdown 标记（链接壳 / 转义 / 强调符），与 PM textContent 对齐 */
function stripInlineMarks(line: string): string {
  return line
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\\([\\`*_[\]{}~#])/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim();
}

/** ATX 标题行：^ {0,3}#{1,6} 后跟空白 */
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
/** Setext 下划线行（= → h1，- → h2） */
const SETEXT_RE = /^ {0,3}(=+|-+)\s*$/;

/** 源码行拆分（记录每行的起始偏移，供光标定位） */
function sourceLines(text: string): { start: number; content: string }[] {
  const lines: { start: number; content: string }[] = [];
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

/** 从 fromLine 起匹配单个标题（level + 文本），返回行号与光标落点 */
function matchHeadingInLines(
  lines: { start: number; content: string }[],
  level: number,
  headingText: string,
  fromLine: number
): { line: number; caret: number } | null {
  for (let i = fromLine; i < lines.length; i++) {
    // ATX：# 120
    const atx = ATX_RE.exec(lines[i].content);
    if (atx && atx[1].length === level && stripInlineMarks(atx[2] ?? '') === headingText) {
      const content = atx[2] ?? '';
      const caret = lines[i].start + atx[0].length - content.length;
      return { line: i, caret };
    }

    // Setext：本行为标题文本，下一行为 = / - 下划线
    const underline = SETEXT_RE.exec(lines[i + 1]?.content ?? '');
    if (underline) {
      const isH1 = underline[1][0] === '=';
      if ((isH1 && level === 1) || (!isH1 && level === 2)) {
        if (stripInlineMarks(lines[i].content) === headingText) {
          return { line: i, caret: lines[i].start };
        }
      }
    }
  }
  return null;
}

/** 在源码文本中按文档顺序定位第 index 个标题的光标落点（找不到返回 null） */
function findSourceHeadingCaret(
  text: string,
  entries: OutlineEntry[],
  index: number
): number | null {
  const lines = sourceLines(text);
  let lineCursor = 0;
  for (let i = 0; i <= index; i++) {
    const entry = entries[i];
    if (!entry) return null;
    const found = matchHeadingInLines(lines, entry.level, entry.text, lineCursor);
    if (found === null) {
      // 顺序失配（源码被编辑过标题）时仅对目标项做一次全量兜底
      if (i === index) {
        const retry = matchHeadingInLines(lines, entry.level, entry.text, 0);
        return retry ? retry.caret : null;
      }
      return null;
    }
    lineCursor = found.line + 1;
    if (i === index) return found.caret;
  }
  return null;
}

/**
 * 源码模式跳转：定位光标到目标标题源码行并滚动到可见。
 * 与渲染模式一致：标题行对齐视口顶部。返回是否成功落点（失败时调用方保持原状）。
 */
function jumpInSource(el: HTMLElement, entries: OutlineEntry[], index: number): boolean {
  const text = el.textContent ?? '';
  const caret = findSourceHeadingCaret(text, entries, index);
  if (caret === null) return false;

  // 定位光标所在文本节点（contenteditable 内可能被拆成多个文本节点）
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (caret <= acc + node.data.length) {
      startNode = node;
      startOffset = Math.min(caret - acc, node.data.length);
      break;
    }
    acc += node.data.length;
  }
  if (!startNode) return false;

  const selection = window.getSelection();
  if (!selection) return false;

  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.collapse(true);

  // 焦点放回源码区后再设选区（contenteditable focus 可能清空选区）
  selection.removeAllRanges();
  selection.addRange(range);
  if (document.activeElement !== el) {
    el.focus();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // 标题行对齐视口顶部（与渲染模式 jumpTo 的定位一致）
  const rect = range.getBoundingClientRect();
  const containerRect = el.getBoundingClientRect();
  if (containerRect.height > 0) {
    const target = el.scrollTop + (rect.top - containerRect.top);
    el.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }
  return true;
}

export interface OutlineController {
  refresh(): void;
  setActive(index: number | null): void;
  jumpTo(index: number): void;
  /** 源码模式光标偏移 → 大纲 active 高亮联动 */
  updateActiveFromSource(text: string, caretOffset: number): void;
  /** 滚动联动：视口顶部附近的标题决定 active（渲染/源码模式都适用） */
  updateActiveFromScroll(): void;
}

export function createOutlinePanel(
  editor: Editor,
  treeEl: HTMLElement,
  deps: OutlinePanelDeps
): OutlineController {
  let entries: (OutlineEntry & { pos: number })[] = [];
  let buttons: HTMLButtonElement[] = [];

  function rebuildDom(): void {
    treeEl.innerHTML = '';
    buttons = [];

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'outline-empty';
      empty.textContent = '暂无标题，使用 # 创建';
      treeEl.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'outline-item';
      btn.dataset.level = String(entry.level);
      btn.title = entry.text;
      btn.textContent = entry.text;
      btn.addEventListener('click', () => controller.jumpTo(entry.index));
      treeEl.appendChild(btn);
      buttons.push(btn);
    }
  }

  const controller: OutlineController = {
    refresh(): void {
      const prevTexts = entries.map((e) => `${e.level}:${e.text}`).join('\n');
      entries = collectHeadings(editor);
      const nextTexts = entries.map((e) => `${e.level}:${e.text}`).join('\n');

      // 内容未变时保留按钮引用与滚动位置，避免闪烁
      if (prevTexts !== nextTexts || buttons.length !== entries.length) {
        rebuildDom();
      }
    },

    setActive(index: number | null): void {
      buttons.forEach((btn, i) => {
        btn.classList.toggle('active', i === index);
        if (i === index) {
          btn.scrollIntoView({ block: 'nearest' });
        }
      });
    },

    /**
     * 源码模式下按光标偏移同步 outline active：
     * 顺序匹配各标题源码行，光标落在哪个标题行（含其上方到下一标题之间）就高亮谁。
     */
    updateActiveFromSource(text: string, caretOffset: number): void {
      if (!deps.isSourceMode() || entries.length === 0) return;
      const lines = sourceLines(text);
      let active: number | null = null;
      let lineCursor = 0;
      for (let i = 0; i < entries.length; i++) {
        const found = matchHeadingInLines(lines, entries[i].level, entries[i].text, lineCursor);
        if (!found) break; // 顺序失配：不再向下匹配（避免误判）
        lineCursor = found.line + 1;
        if (caretOffset >= lines[found.line].start) {
          active = i;
        } else {
          break; // 光标在该标题行上方 → 保持已确认的前一项
        }
      }
      controller.setActive(active);
    },

    /**
     * 滚动联动：视口顶部附近的标题决定 outline active。
     * 渲染模式按标题 DOM 矩形判定；源码模式把「视口顶行」换算为文本偏移
     * 后复用 updateActiveFromSource 的标题行匹配。
     */
    updateActiveFromScroll(): void {
      if (deps.isSourceMode()) {
        const el = deps.sourceEl();
        if (!el || entries.length === 0) return;
        const containerRect = el.getBoundingClientRect();
        if (containerRect.height === 0) return;
        // 滚到底：末尾标题可能因内容不足无法到达视口顶部，直接高亮最后一项
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
          controller.setActive(entries.length - 1);
          return;
        }
        // 文本起点在 56px 左 padding 之后，取 +60 保证命中正文行
        const range = document.caretRangeFromPoint(
          containerRect.left + 60,
          containerRect.top + SCROLL_ACTIVE_THRESHOLD_PX
        );
        if (!range) return;
        const pre = document.createRange();
        pre.selectNodeContents(el);
        pre.setEnd(range.startContainer, range.startOffset);
        controller.updateActiveFromSource(el.textContent ?? '', pre.toString().length);
        return;
      }

      const container = document.querySelector('#editor-container');
      const pm = document.querySelector('.ProseMirror');
      if (!container || !pm || entries.length === 0) return;
      const count = Math.min(pm.querySelectorAll('h1, h2, h3, h4, h5, h6').length, entries.length);
      // 滚到底：末尾标题可能因内容不足无法到达视口顶部，直接高亮最后一项
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 1) {
        if (count > 0) controller.setActive(count - 1);
        return;
      }
      const containerTop = container.getBoundingClientRect().top;
      const headings = pm.querySelectorAll('h1, h2, h3, h4, h5, h6');
      let active: number | null = null;
      for (let i = 0; i < count; i++) {
        const top = (headings[i] as HTMLElement).getBoundingClientRect().top;
        if (top <= containerTop + SCROLL_ACTIVE_THRESHOLD_PX) {
          active = i; // 最后一个滚过/触及顶部的标题
        } else {
          break;
        }
      }
      // 未滚到任何标题（视口顶部在第一个标题上方）时高亮第一项
      controller.setActive(active ?? (count > 0 ? 0 : null));
    },

    jumpTo(index: number): void {
      const target = entries[index];
      if (!target) return;

      // 源码模式：在源码文本中定位标题行（保持停留在源码模式）
      const sourceEl = deps.sourceEl();
      if (deps.isSourceMode() && sourceEl) {
        if (jumpInSource(sourceEl, entries, index)) {
          controller.setActive(index);
        }
        return;
      }

      let scrollTarget = 0;
      let container: HTMLElement | null = null;
      let pmDom: HTMLElement | null = null;

      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const $pos = view.state.doc.resolve(target.pos + 1);
        const selection = TextSelection.near($pos, 1);
        view.dispatch(view.state.tr.setSelection(selection));

        container = document.querySelector('#editor-container') as HTMLElement;
        pmDom = view.dom;

        // 直接按 heading 层级从 DOM 里找对应标题（比 domAtPos 更可靠）
        const allHeadings = view.dom.querySelectorAll('h1, h2, h3, h4, h5, h6');
        const headingEl = allHeadings[index] as HTMLElement | undefined;
        if (headingEl && container) {
          const headingRect = headingEl.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();
          scrollTarget = headingRect.top - containerRect.top + container.scrollTop;
        }
      });

      setTimeout(() => {
        if (scrollTarget > 0 && container) {
          container.scrollTo({ top: scrollTarget, behavior: 'smooth' });
        }
        // 把焦点还给编辑器，preventScroll 阻止浏览器原生 focus-scroll 撤销滚动
        pmDom?.focus({ preventScroll: true });
        controller.setActive(index);
      }, 0);
    }
  };

  // 滚动联动：视口顶部附近的标题决定 outline active（rAF 合并每帧多次 scroll）
  let scrollPending = false;
  const onScroll = (): void => {
    if (scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(() => {
      scrollPending = false;
      controller.updateActiveFromScroll();
    });
  };
  document
    .querySelector('#editor-container')
    ?.addEventListener('scroll', onScroll, { passive: true });
  deps.sourceEl()?.addEventListener('scroll', onScroll, { passive: true });

  return controller;
}

/** 计算光标当前所在标题的序号（用于高亮大纲项） */
export function activeHeadingIndex(editor: Editor, totalHeadings: number): number | null {
  let result: number | null = null;

  editor.action((ctx) => {
    const state = ctx.get(editorViewCtx).state;
    const $from = state.selection.$from;

    let headingDepth = -1;
    for (let depth = $from.depth; depth >= 0; depth--) {
      if ($from.node(depth).type.name === 'heading') {
        headingDepth = depth;
        break;
      }
    }
    if (headingDepth < 0) return;

    // 计算该标题是文档中的第几个 heading
    const headingPos = $from.before(headingDepth);
    let index = 0;
    let found = false;
    state.doc.descendants((node, pos) => {
      if (found) return false;
      if (node.type.name === 'heading') {
        if (pos === headingPos) {
          found = true;
          return false;
        }
        index++;
      }
      return true;
    });

    if (found && index < totalHeadings) result = index;
  });

  return result;
}
