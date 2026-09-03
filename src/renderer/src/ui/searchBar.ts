/* ============================================================
 * 搜索栏组件：Ctrl+F 查找 / Esc 关闭 / Enter 下一个 / Shift+Enter 上一个
 * 替换功能：Ctrl+H 切换替换面板
 * 渲染模式和源码模式统一使用 CSS Custom Highlight API
 * ============================================================ */

import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx } from '@milkdown/kit/core';

import { insertTextViaInputEvent } from '@/util/inputEvent';

export interface SearchBar {
  container: HTMLElement;
  show(): void;
  hide(): void;
  toggle(): void;
  toggleReplace(): void;
}

class SearchBarController implements SearchBar {
  container: HTMLElement;

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
  private doHighlight(keyword: string): void {
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
        pos = idx + 1;
      }
    });

    // 添加所有匹配到高亮
    ranges.forEach((range, i) => {
      if (i === 0) {
        this.searchHighlightCurrent.add(range);
      } else {
        this.searchHighlight.add(range);
      }
    });

    this.currentRanges = ranges;
    this.matchIndex = this.totalMatches > 0 ? 1 : 0;
    this.matchCount.textContent =
      this.totalMatches > 0 ? `${this.matchIndex}/${this.totalMatches}` : '0/0';

    if (this.totalMatches > 0) {
      this.scrollToCurrent();
    }
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
      const scrollOffset = rect.top - containerRect.top - containerRect.height / 2;
      scrollContainer.scrollBy({ top: scrollOffset, behavior: 'smooth' });
    }
  }

  private updateHighlightIndex(): void {
    if (this.currentRanges.length === 0) return;

    this.clearHighlights();

    this.currentRanges.forEach((range, i) => {
      if (i === this.matchIndex - 1) {
        this.searchHighlightCurrent.add(range);
      } else {
        this.searchHighlight.add(range);
      }
    });

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
  toggleReplace(): void {
    this.replaceVisible = !this.replaceVisible;
    this.replaceRow.style.display = this.replaceVisible ? 'flex' : 'none';
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

    // 替换后重新搜索
    this.doHighlight(this.lastKeyword);
    if (this.totalMatches > 0) {
      this.matchIndex = this.matchIndex > this.totalMatches ? 1 : this.matchIndex;
      this.matchCount.textContent = `${this.matchIndex}/${this.totalMatches}`;
      this.updateHighlightIndex();
    }
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

  private replaceInRenderMode(range: Range, replaceText: string): void {
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);

      // 使用 ProseMirror 的 posAtDOM 方法找到位置
      const pmFrom = view.posAtDOM(range.startContainer, range.startOffset);
      const pmTo = view.posAtDOM(range.endContainer, range.endOffset);

      if (pmFrom < 0 || pmTo < 0) return;

      // 创建替换事务
      const tr = view.state.tr.insertText(replaceText, pmFrom, pmTo);
      view.dispatch(tr);
    });
  }

  private replaceAllInRenderMode(replaceText: string): void {
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      let tr = view.state.tr;

      // 从后往前替换，避免位置偏移
      const ranges = [...this.currentRanges].reverse();
      for (const range of ranges) {
        const pmFrom = view.posAtDOM(range.startContainer, range.startOffset);
        const pmTo = view.posAtDOM(range.endContainer, range.endOffset);

        if (pmFrom < 0 || pmTo < 0) continue;

        tr = tr.insertText(replaceText, pmFrom, pmTo);
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
