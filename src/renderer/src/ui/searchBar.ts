/* ============================================================
 * 搜索栏组件：Ctrl+F 查找 / Esc 关闭 / Enter 下一个 / Shift+Enter 上一个
 * 替换功能：Ctrl+H 打开查找+替换（幂等，可连按）
 * 渲染模式和源码模式统一使用 CSS Custom Highlight API
 * ============================================================ */

import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx } from '@milkdown/kit/core';
import type { EditorView } from '@milkdown/kit/prose/view';

import { insertTextViaInputEvent } from '@/util/inputEvent';
import { screenPxToLocal } from './zoom';

export interface SearchBar {
  show(): void;
  hide(): void;
  toggle(): void;
  /** Ctrl+H 语义：确保搜索栏打开 + 替换行可见（幂等，连按两次状态不变）。
   * 旧实现是 toggle()+toggleReplace() 组合——替换面板已开时先整个关掉
   * 再把 replace 行显示在隐藏容器里，状态直接错乱。 */
  openWithReplace(): void;
  /** 文档变化后重扫高亮（保持当前序号、不抢滚动）。
   * 搜索高亮存的是 DOM Range，PM 改写文档后 Range 陈旧——不重扫的话
   * 「替换/全部替换」拿陈旧 Range 换算 PM 位置会抛 RangeError 或替换错位。 */
  refresh(): void;
}

class SearchBarController implements SearchBar {
  private readonly container: HTMLElement;

  private readonly input: HTMLInputElement;
  private readonly matchCount: HTMLSpanElement;
  private readonly replaceRow: HTMLDivElement;
  private readonly replaceInput: HTMLInputElement;

  private readonly searchHighlight = new Highlight();
  private readonly searchHighlightCurrent = new Highlight();

  private matchIndex = 0;
  private totalMatches = 0;
  private lastKeyword = '';
  private replaceVisible = false;
  private currentRanges: Range[] = [];

  constructor(
    private readonly parent: HTMLElement,
    private readonly getSourceMode: () => boolean,
    private readonly getSourceElement: () => HTMLElement | null,
    private readonly editor: Editor
  ) {
    this.container = document.createElement('div');
    this.container.id = 'search-bar';
    this.container.style.display = 'none';

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.id = 'search-input';
    this.input.placeholder = '查找…';
    this.input.spellcheck = false;

    this.matchCount = document.createElement('span');
    this.matchCount.id = 'search-match-count';
    this.matchCount.textContent = '0/0';

    const btnPrev = this.makeButton('search-prev', '上一个 (Shift+Enter)', '‹');
    const btnNext = this.makeButton('search-next', '下一个 (Enter)', '›');
    const btnToggleReplace = this.makeButton('search-toggle-replace', '切换替换 (Ctrl+H)', '⇄');
    const btnClose = this.makeButton('search-close', '关闭 (Esc)', '✕');

    this.container.append(
      this.input,
      this.matchCount,
      btnPrev,
      btnNext,
      btnToggleReplace,
      btnClose
    );

    // ---------- 替换行 ----------
    this.replaceRow = document.createElement('div');
    this.replaceRow.id = 'replace-row';
    this.replaceRow.style.display = 'none';

    this.replaceInput = document.createElement('input');
    this.replaceInput.type = 'text';
    this.replaceInput.id = 'replace-input';
    this.replaceInput.placeholder = '替换…';
    this.replaceInput.spellcheck = false;

    const btnReplace = this.makeButton('btn-replace', '替换当前', '替换');
    const btnReplaceAll = this.makeButton('btn-replace-all', '全部替换', '全部');

    this.replaceRow.append(this.replaceInput, btnReplace, btnReplaceAll);
    this.container.append(this.replaceRow);
    this.parent.appendChild(this.container);

    // CSS Custom Highlight API 注册与样式（::highlight 规则见 layout.css）
    CSS.highlights.set('search-highlight', this.searchHighlight);
    CSS.highlights.set('search-highlight-current', this.searchHighlightCurrent);

    this.bindEvents(btnPrev, btnNext, btnToggleReplace, btnClose, btnReplace, btnReplaceAll);
  }

  private makeButton(id: string, title: string, text: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = id;
    btn.title = title;
    btn.textContent = text;
    return btn;
  }

  private bindEvents(
    btnPrev: HTMLButtonElement,
    btnNext: HTMLButtonElement,
    btnToggleReplace: HTMLButtonElement,
    btnClose: HTMLButtonElement,
    btnReplace: HTMLButtonElement,
    btnReplaceAll: HTMLButtonElement
  ): void {
    this.input.addEventListener('input', () => {
      this.lastKeyword = this.input.value.trim();
      this.doHighlight(this.lastKeyword);
    });

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) this.navigatePrev();
        else this.navigateNext();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.hide();
      }
    });

    this.replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.replaceCurrent();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.hide();
      }
    });

    btnNext.addEventListener('click', () => this.navigateNext());
    btnPrev.addEventListener('click', () => this.navigatePrev());
    btnClose.addEventListener('click', () => this.hide());
    // 按钮保留"切换"语义（再点收起替换行）；Ctrl+H 走 openWithReplace 幂等
    btnToggleReplace.addEventListener('click', () => this.toggleReplace());
    btnReplace.addEventListener('click', () => this.replaceCurrent());
    btnReplaceAll.addEventListener('click', () => this.replaceAllMatches());
  }

  private getEditorDom(): HTMLElement | null {
    return document.querySelector('.ProseMirror');
  }

  private clearHighlights(): void {
    this.searchHighlight.clear();
    this.searchHighlightCurrent.clear();
  }

  // ---------- 统一搜索逻辑（渲染模式 + 源码模式） ----------

  /** 高亮重扫选项：keepIndex 保持当前序号（夹到新总数）；scroll 控制是否滚到当前匹配 */
  private doHighlight(
    keyword: string,
    opts: { keepIndex?: boolean; scroll?: boolean } = {}
  ): void {
    const previousIndex = this.matchIndex;
    this.clearHighlights();
    this.totalMatches = 0;
    this.matchIndex = 0;
    this.currentRanges = [];

    if (!keyword) {
      this.matchCount.textContent = '0/0';
      return;
    }

    // 根据模式选择搜索目标
    const targetEl = this.getSourceMode() ? this.getSourceElement() : this.getEditorDom();
    if (!targetEl) return;

    this.lastKeyword = keyword;
    const lowerKeyword = keyword.toLowerCase();

    // 收集所有文本节点
    const walker = document.createTreeWalker(targetEl, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode as Text);
    }

    // 查找所有匹配并创建 Range
    const ranges: Range[] = [];
    textNodes.forEach((node) => {
      const text = node.textContent || '';
      const lowerText = text.toLowerCase();

      let pos = 0;
      while (pos < lowerText.length) {
        const idx = lowerText.indexOf(lowerKeyword, pos);
        if (idx === -1) break;

        const range = new Range();
        range.setStart(node, idx);
        range.setEnd(node, idx + keyword.length);
        ranges.push(range);

        this.totalMatches++;
        // 匹配推进必须**非重叠**（idx + keyword.length），与 replaceAll 的推进
        // 同口径：旧实现 pos = idx + 1 允许重叠匹配（'aa' 在 'aaaa' 记 3 处），
        // 而替换按非重叠只替 2 处——计数与替换结果对不上；渲染模式"全部替换"
        // 还会对重叠区间反向 insertText 互相踩踏、破坏正文
        pos = idx + keyword.length;
      }
    });

    this.currentRanges = ranges;
    if (this.totalMatches === 0) {
      this.matchCount.textContent = '0/0';
      return;
    }

    this.matchIndex =
      opts.keepIndex && previousIndex > 0 ? Math.min(previousIndex, this.totalMatches) : 1;
    this.paintCurrent();
    this.matchCount.textContent = `${this.matchIndex}/${this.totalMatches}`;
    if (opts.scroll !== false) this.scrollToCurrent();
  }

  /** 按当前 matchIndex 重新着色（当前匹配用高亮色，其余普通色） */
  private paintCurrent(): void {
    this.clearHighlights();
    this.currentRanges.forEach((range, i) => {
      if (i === this.matchIndex - 1) {
        this.searchHighlightCurrent.add(range);
      } else {
        this.searchHighlight.add(range);
      }
    });
  }

  refresh(): void {
    // 隐藏 / 无关键词时无需重扫（编辑期间每笔输入都会走到这里）
    if (this.container.style.display === 'none') return;
    if (!this.lastKeyword) return;
    // 保持序号、不抢滚动：用户正在文档里打字，视口不能被搜索栏拽走
    this.doHighlight(this.lastKeyword, { keepIndex: true, scroll: false });
  }

  private scrollToCurrent(): void {
    if (this.currentRanges.length === 0) return;

    const currentRange = this.currentRanges[this.matchIndex - 1];
    if (!currentRange) return;

    // 获取滚动容器
    const scrollContainer = this.getSourceMode()
      ? this.getSourceElement()
      : document.getElementById('editor-container');
    if (!scrollContainer) return;

    const rect = currentRange.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();

    if (rect.top < containerRect.top || rect.bottom > containerRect.bottom) {
      // rect 差值是屏幕像素（zoom 子树内 ×zoom），scrollBy 的 top 是局部单位——
      // 换算见 screenPxToLocal；容器高度用 clientHeight（恒为局部单位）
      const scrollOffset =
        screenPxToLocal(scrollContainer, rect.top - containerRect.top) -
        scrollContainer.clientHeight / 2;
      scrollContainer.scrollBy({ top: scrollOffset, behavior: 'smooth' });
    }
  }

  private updateHighlightIndex(): void {
    if (this.currentRanges.length === 0) return;
    this.paintCurrent();
    this.scrollToCurrent();
  }

  private navigateNext(): void {
    if (this.totalMatches === 0) return;
    this.matchIndex = this.matchIndex >= this.totalMatches ? 1 : this.matchIndex + 1;
    this.matchCount.textContent = `${this.matchIndex}/${this.totalMatches}`;
    this.updateHighlightIndex();
  }

  private navigatePrev(): void {
    if (this.totalMatches === 0) return;
    this.matchIndex = this.matchIndex <= 1 ? this.totalMatches : this.matchIndex - 1;
    this.matchCount.textContent = `${this.matchIndex}/${this.totalMatches}`;
    this.updateHighlightIndex();
  }

  // ---------- 替换功能 ----------
  private toggleReplace(): void {
    this.replaceVisible = !this.replaceVisible;
    this.replaceRow.style.display = this.replaceVisible ? 'flex' : 'none';
  }

  openWithReplace(): void {
    this.show();
    this.replaceVisible = true;
    this.replaceRow.style.display = 'flex';
  }

  private replaceCurrent(): void {
    if (this.totalMatches === 0 || this.matchIndex === 0) return;
    const replaceText = this.replaceInput.value;
    const currentRange = this.currentRanges[this.matchIndex - 1];
    if (!currentRange) return;

    if (this.getSourceMode()) {
      this.replaceInSourceMode(currentRange, replaceText);
    } else {
      // 渲染模式：用 ProseMirror 事务
      this.replaceInRenderMode(currentRange, replaceText);
    }

    // 替换后重新搜索：**保持原序号**（替换第 5/10 处后仍指向下一处，
    // 旧实现重扫后 matchIndex 回 1——连替多处时高亮跳回第 1 处）
    this.doHighlight(this.lastKeyword, { keepIndex: true });
  }

  private replaceAllMatches(): void {
    if (this.totalMatches === 0) return;
    const replaceText = this.replaceInput.value;
    const count = this.totalMatches;

    if (this.getSourceMode()) {
      this.replaceAllInSourceMode(replaceText);
    } else {
      this.replaceAllInRenderMode(replaceText);
    }

    // 清除高亮并提示（提示复用计数区，避免浏览器 alert）
    this.clearHighlights();
    this.currentRanges = [];
    this.totalMatches = 0;
    this.matchIndex = 0;
    this.matchCount.textContent = `已替换 ${count} 处`;
    window.setTimeout(() => {
      if (this.matchCount.textContent.startsWith('已替换')) {
        this.matchCount.textContent = '0/0';
      }
    }, 1600);
  }

  private replaceInSourceMode(range: Range, replaceText: string): void {
    const sourceEl = this.getSourceElement();
    if (!sourceEl) return;

    const selection = window.getSelection();
    if (!selection) return;

    // 选中要替换的文本；焦点若在按钮上先放回编辑区（不改变选区）
    selection.removeAllRanges();
    selection.addRange(range);
    if (document.activeElement !== sourceEl) {
      sourceEl.focus();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    insertTextViaInputEvent(sourceEl, replaceText);
  }

  private replaceAllInSourceMode(replaceText: string): void {
    const sourceEl = this.getSourceElement();
    if (!sourceEl) return;

    const text = sourceEl.textContent || '';
    const lowerText = text.toLowerCase();
    const lowerKeyword = this.lastKeyword.toLowerCase();

    let result = '';
    let lastIndex = 0;
    let count = 0;

    while (true) {
      const idx = lowerText.indexOf(lowerKeyword, lastIndex);
      if (idx === -1) break;

      result += text.slice(lastIndex, idx) + replaceText;
      lastIndex = idx + this.lastKeyword.length;
      count++;
    }

    if (count === 0) return;
    result += text.slice(lastIndex);

    // 全选后整体插入，作为一次撤销操作
    const selection = window.getSelection();
    if (!selection) return;

    const range = document.createRange();
    range.selectNodeContents(sourceEl);
    selection.removeAllRanges();
    selection.addRange(range);
    if (document.activeElement !== sourceEl) {
      sourceEl.focus();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    insertTextViaInputEvent(sourceEl, result);
  }

  /**
   * 高亮 Range → PM 文档位置。posAtDOM 对"编辑器外节点 / 陈旧 Range"直接
   * 抛 RangeError（prosemirror-view：`DOM position not inside the editor`）——
   * 搜索栏没有文档变更订阅时 Range 必然陈旧，旧代码 `if (pmFrom < 0)` 是
   * 永不生效的死护栏（posAtDOM 只抛错不返回负数），异常一路抛穿点击处理器。
   * 换算失败返回 null 由调用方跳过该匹配。
   */
  private toPmRange(view: EditorView, range: Range): { from: number; to: number } | null {
    try {
      const from = view.posAtDOM(range.startContainer, range.startOffset);
      const to = view.posAtDOM(range.endContainer, range.endOffset);
      return { from, to };
    } catch {
      return null;
    }
  }

  private replaceInRenderMode(range: Range, replaceText: string): void {
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const pm = this.toPmRange(view, range);
      if (!pm) return;

      // 创建替换事务
      const tr = view.state.tr.insertText(replaceText, pm.from, pm.to);
      view.dispatch(tr);
    });
  }

  private replaceAllInRenderMode(replaceText: string): void {
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      let tr = view.state.tr;

      // 从后往前替换，避免位置偏移（匹配区间已保证非重叠，
      // 反向 insertText 不会互相踩踏）
      const ranges = [...this.currentRanges].reverse();
      for (const range of ranges) {
        const pm = this.toPmRange(view, range);
        if (!pm) continue;

        tr = tr.insertText(replaceText, pm.from, pm.to);
      }

      view.dispatch(tr);
    });
  }

  show(): void {
    this.container.style.display = 'flex';
    this.input.focus();
    this.input.select();
    if (this.input.value.trim()) {
      this.lastKeyword = this.input.value.trim();
      this.doHighlight(this.lastKeyword);
    }
  }

  hide(): void {
    this.container.style.display = 'none';
    this.replaceRow.style.display = 'none';
    this.replaceVisible = false;
    this.clearHighlights();
    this.currentRanges = [];
    this.totalMatches = 0;
    this.matchIndex = 0;
    this.matchCount.textContent = '0/0';
    // 聚焦回编辑区
    if (this.getSourceMode()) {
      this.getSourceElement()?.focus();
    } else {
      this.getEditorDom()?.focus();
    }
  }

  toggle(): void {
    if (this.container.style.display === 'none') {
      this.show();
    } else {
      this.hide();
    }
  }
}

export function createSearchBar(
  parent: HTMLElement,
  getSourceMode: () => boolean,
  getSourceElement: () => HTMLElement | null,
  editor: Editor
): SearchBar {
  return new SearchBarController(parent, getSourceMode, getSourceElement, editor);
}
