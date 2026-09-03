import katex from 'katex';
import remarkMath from 'remark-math';

import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { InputRule } from '@milkdown/kit/prose/inputrules';
import { NodeSelection } from '@milkdown/kit/prose/state';
import type { EditorView, NodeView } from '@milkdown/kit/prose/view';
import { $inputRule, $nodeSchema, $remark, $view } from '@milkdown/kit/utils';

import { escapeHtml } from '../util/escape';

/* ============================================================
 * 数学公式支持：remark-math 解析 + KaTeX 渲染
 * - 块级公式：$$ ... $$（mdast 类型 math）
 * - 行内公式：$...$（mdast 类型 inlineMath）
 * 编辑交互：点击选中节点 → 出现源码编辑框，失焦/取消选中后重新渲染
 * ============================================================ */

/** 挂载 remark-math 插件（解析仍由 remark 生态完成） */
export const remarkMathPlugin = $remark('MATH_REMARK', () => remarkMath);

function renderMath(value: string, displayMode: boolean): string {
  try {
    return katex.renderToString(value, {
      displayMode,
      throwOnError: false,
      strict: false,
      output: 'html'
    });
  } catch (error) {
    return `<span class="typewren-math-error">${escapeHtml(String(error))}</span>`;
  }
}

/* ------------------------------------------------------------
 * Schema 定义
 * ------------------------------------------------------------ */

/** 块级公式节点（$$…$$），原子节点，LaTeX 存于 attrs.value */
export const mathBlockSchema = $nodeSchema('math', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  defining: true,
  isolating: true,
  attrs: {
    value: { default: '', validate: 'string' }
  },
  parseDOM: [
    {
      tag: 'div[data-math-value]',
      getAttrs: (dom) => ({
        value: (dom as HTMLElement).getAttribute('data-math-value') ?? ''
      })
    }
  ],
  toDOM: (node) => [
    'div',
    {
      class: 'typewren-math-block',
      'data-math-value': node.attrs.value as string
    }
  ],
  parseMarkdown: {
    match: ({ type }) => type === 'math',
    runner: (state, node, type) => {
      state.addNode(type, { value: (node.value as string) ?? '' });
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math',
    runner: (state, node) => {
      state.addNode('math', undefined, node.attrs.value as string);
    }
  }
}));

/** 行内公式节点（$…$），原子节点，LaTeX 存于 attrs.value */
export const mathInlineSchema = $nodeSchema('inline_math', () => ({
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  defining: true,
  isolating: true,
  attrs: {
    value: { default: '', validate: 'string' }
  },
  parseDOM: [
    {
      tag: 'span[data-inline-math]',
      getAttrs: (dom) => ({
        value: (dom as HTMLElement).getAttribute('data-inline-math') ?? ''
      })
    }
  ],
  toDOM: (node) => [
    'span',
    {
      class: 'typewren-math-inline',
      'data-inline-math': node.attrs.value as string
    }
  ],
  parseMarkdown: {
    match: ({ type }) => type === 'inlineMath',
    runner: (state, node, type) => {
      state.addNode(type, { value: (node.value as string) ?? '' });
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'inline_math',
    runner: (state, node) => {
      state.addNode('inlineMath', undefined, node.attrs.value as string);
    }
  }
}));

/* ------------------------------------------------------------
 * NodeView：渲染 KaTeX + 源码编辑
 * ------------------------------------------------------------ */

class MathBlockView implements NodeView {
  dom: HTMLElement;
  renderEl: HTMLElement;
  editorEl: HTMLTextAreaElement;

  constructor(
    private node: ProseNode,
    private view: EditorView,
    private getPos: () => number | undefined
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'typewren-math-block';

    this.renderEl = document.createElement('div');
    this.renderEl.className = 'math-rendered';

    this.editorEl = document.createElement('textarea');
    this.editorEl.className = 'math-src-editor';
    this.editorEl.spellcheck = false;
    this.editorEl.placeholder = '输入 LaTeX，如 \\frac{a}{b}';
    this.editorEl.addEventListener('input', () => this.autoResize());
    this.editorEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.commit();
        this.view.focus();
      }
    });

    this.dom.append(this.renderEl, this.editorEl);
    this.render(this.node.attrs.value as string);
  }

  private autoResize(): void {
    this.editorEl.style.height = 'auto';
    this.editorEl.style.height = `${this.editorEl.scrollHeight}px`;
  }

  private render(value: string): void {
    this.renderEl.innerHTML = renderMath(value, true);
  }

  private commit(): void {
    const next = this.editorEl.value.replace(/\s+$/g, '');
    if (next === (this.node.attrs.value as string)) return;

    const pos = this.getPos();
    if (pos === undefined) return;

    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, {
      ...this.node.attrs,
      value: next
    });
    this.view.dispatch(tr);
    this.node = tr.doc.nodeAt(pos) ?? this.node;
    this.render(next);
  }

  selectNode(): void {
    this.dom.classList.add('math-editing');
    this.editorEl.value = this.node.attrs.value as string;
    this.autoResize();
    requestAnimationFrame(() => {
      this.editorEl.focus();
      this.editorEl.setSelectionRange(this.editorEl.value.length, this.editorEl.value.length);
    });
  }

  deselectNode(): void {
    this.dom.classList.remove('math-editing');
    this.commit();
  }

  stopEvent(event: Event): boolean {
    return event.target === this.editorEl;
  }

  ignoreMutation(): boolean {
    return true;
  }

  update(nextNode: ProseNode): boolean {
    if (nextNode.type !== this.node.type) return false;
    this.node = nextNode;
    if (!this.dom.classList.contains('math-editing')) {
      this.render(nextNode.attrs.value as string);
    }
    return true;
  }

  destroy(): void {
    this.dom.remove();
  }
}

class MathInlineView implements NodeView {
  dom: HTMLElement;
  renderEl: HTMLElement;
  editorEl: HTMLInputElement;

  constructor(
    private node: ProseNode,
    private view: EditorView,
    private getPos: () => number | undefined
  ) {
    this.dom = document.createElement('span');
    this.dom.className = 'typewren-math-inline';

    this.renderEl = document.createElement('span');
    this.renderEl.className = 'math-rendered';

    this.editorEl = document.createElement('input');
    this.editorEl.type = 'text';
    this.editorEl.className = 'math-src-editor';
    this.editorEl.spellcheck = false;
    this.editorEl.placeholder = 'LaTeX';
    this.editorEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        this.commit();
        this.view.focus();
      }
    });

    this.dom.append(this.renderEl, this.editorEl);
    this.render(this.node.attrs.value as string);
  }

  private render(value: string): void {
    this.renderEl.innerHTML = value.trim().length > 0 ? renderMath(value, false) : '<em>∅</em>';
  }

  private commit(): void {
    const next = this.editorEl.value.trim();
    if (next === (this.node.attrs.value as string)) return;

    const pos = this.getPos();
    if (pos === undefined) return;

    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, {
      ...this.node.attrs,
      value: next
    });
    this.view.dispatch(tr);
    this.node = tr.doc.nodeAt(pos) ?? this.node;
    this.render(next);
  }

  selectNode(): void {
    this.dom.classList.add('math-editing');
    this.editorEl.style.display = 'inline-block';
    this.editorEl.value = this.node.attrs.value as string;
    requestAnimationFrame(() => {
      this.editorEl.focus();
      this.editorEl.select();
    });
  }

  deselectNode(): void {
    this.dom.classList.remove('math-editing');
    this.editorEl.style.display = '';
    this.commit();
  }

  stopEvent(event: Event): boolean {
    return event.target === this.editorEl;
  }

  ignoreMutation(): boolean {
    return true;
  }

  update(nextNode: ProseNode): boolean {
    if (nextNode.type !== this.node.type) return false;
    this.node = nextNode;
    if (this.editorEl.style.display === '') {
      this.render(nextNode.attrs.value as string);
    }
    return true;
  }

  destroy(): void {
    this.dom.remove();
  }
}

export const mathBlockView = $view(mathBlockSchema.node, () => {
  return (node, view, getPos) => new MathBlockView(node, view, getPos);
});

export const mathInlineView = $view(mathInlineSchema.node, () => {
  return (node, view, getPos) => new MathInlineView(node, view, getPos);
});

/* ------------------------------------------------------------
 * 输入规则
 * ------------------------------------------------------------ */

/** 输入 `$latex$`（再敲任意键触发匹配）立即转为行内公式 */
export const inlineMathInputRule = $inputRule((ctx) => {
  return new InputRule(/\$([^$\n]+)\$$/, (state, match, start, end) => {
    const latex = match[1];
    if (!latex || latex.trim().length === 0) return null;

    const node = mathInlineSchema.type(ctx).create({ value: latex });
    if (!node) return null;

    return state.tr.replaceWith(start, end, node);
  });
});

/** 输入完整 `$$formula$$` + 空格 → 转为块级公式 */
export const blockMathFullInputRule = $inputRule((ctx) => {
  return new InputRule(/^\$\$([^$\n]+)\$\$\s$/, (state, match, start, end) => {
    const latex = match[1];
    if (latex === undefined) return null;

    const node = mathBlockSchema.type(ctx).create({ value: latex });
    if (!node) return null;

    return state.tr.replaceWith(start, end, node);
  });
});

/** 行首输入 `$$` + 空格 → 创建空块级公式并进入编辑状态 */
export const blockMathEmptyInputRule = $inputRule((ctx) => {
  return new InputRule(/^(\$\$)(\s)$/, (state, _match, _start, _end) => {
    const { $from } = state.selection;
    if ($from.parent.type.name !== 'paragraph') return null;
    if ($from.parent.textContent !== '$$') return null;

    const node = mathBlockSchema.type(ctx).create({ value: '' });
    if (!node) return null;

    const blockStart = $from.before();
    const blockEnd = $from.after();

    const tr = state.tr.replaceWith(blockStart, blockEnd, node);
    tr.setSelection(NodeSelection.create(tr.doc, blockStart));
    return tr;
  });
});
