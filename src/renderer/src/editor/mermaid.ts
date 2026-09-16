import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { NodeSelection, Plugin } from '@milkdown/kit/prose/state';
import type { EditorView, NodeView } from '@milkdown/kit/prose/view';
import { $nodeSchema, $prose, $remark, $view } from '@milkdown/kit/utils';

import { escapeHtml } from '../util/escape';
import { currentTheme } from '../ui/theme';

/* ============================================================
 * Mermaid 图表支持：```mermaid 代码块 → 图表节点
 * - 解析侧：$remark 把 lang=mermaid 的 mdast code 重命名成独立类型
 *   （避免被 code_block 的 parseMarkdown match 抢先消费）；
 * - 运行时：mermaid 包体积大（~2MB），懒加载并按主题初始化；
 * - 编辑交互：与数学公式一致（选中节点 → 源码编辑框）。
 * ============================================================ */

export const MERMAID_NODE = 'typewren_mermaid';

/** mdast code(lang=mermaid) → 独立节点类型（其余 code 原样留给 code_block）。
 * 注意 $remark 工厂须返回**插件**（(options) => transformer），直接返回
 * transformer 会被当插件调用、转换体永不执行。 */
export const remarkMermaidPlugin = $remark('MERMAID_REMARK', () => {
  return () => {
    return (tree: unknown) => {
      const visit = (node: Record<string, unknown>): void => {
        if (node.type === 'code' && node.lang === 'mermaid') {
          node.type = MERMAID_NODE;
          delete node.lang;
          delete node.meta;
        }
        const children = node.children;
        if (Array.isArray(children)) {
          for (const child of children) visit(child as Record<string, unknown>);
        }
      };
      visit(tree as Record<string, unknown>);
    };
  };
});

/* ------------------------------------------------------------
 * Schema：块级原子节点，图表源码存于 attrs.value
 * ------------------------------------------------------------ */
export const mermaidBlockSchema = $nodeSchema(MERMAID_NODE, () => ({
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
      tag: 'div[data-mermaid-value]',
      getAttrs: (dom) => ({
        value: (dom as HTMLElement).getAttribute('data-mermaid-value') ?? ''
      })
    }
  ],
  toDOM: (node) => [
    'div',
    {
      class: 'typewren-mermaid-block',
      'data-mermaid-value': node.attrs.value as string
    }
  ],
  parseMarkdown: {
    match: ({ type }) => type === MERMAID_NODE,
    runner: (state, node, type) => {
      state.addNode(type, { value: (node.value as string) ?? '' });
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === MERMAID_NODE,
    runner: (state, node) => {
      state.addNode('code', undefined, node.attrs.value as string, { lang: 'mermaid' });
    }
  }
}));

/* ------------------------------------------------------------
 * Mermaid 懒加载与渲染（编辑器渲染与导出共用）
 * ------------------------------------------------------------ */

type MermaidModule = typeof import('mermaid').default;

let mermaidPromise: Promise<MermaidModule> | null = null;

/** 首次使用时才加载 mermaid（~2MB，不拖累首屏） */
function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => mod.default);
  }
  return mermaidPromise;
}

let renderSeq = 0;

/** 渲染 mermaid 源码为 SVG 字符串；初始化为当前主题（亮/暗跟随应用） */
export async function renderMermaidSvg(code: string): Promise<string> {
  const mermaid = await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: currentTheme() === 'dark' ? 'dark' : 'default',
    fontFamily: 'inherit'
  });
  renderSeq += 1;
  const { svg } = await mermaid.render(`mermaid-${renderSeq}`, code);
  return svg;
}

/* ------------------------------------------------------------
 * NodeView：渲染 SVG + 选中时源码编辑
 * ------------------------------------------------------------ */
class MermaidBlockView implements NodeView {
  dom: HTMLElement;
  renderEl: HTMLElement;
  editorEl: HTMLTextAreaElement;

  constructor(
    private node: ProseNode,
    private view: EditorView,
    private getPos: () => number | undefined
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'typewren-mermaid-block';
    this.dom.setAttribute('data-mermaid-value', this.node.attrs.value as string);

    this.renderEl = document.createElement('div');
    this.renderEl.className = 'mermaid-rendered';

    this.editorEl = document.createElement('textarea');
    this.editorEl.className = 'math-src-editor'; // 复用公式编辑框样式
    this.editorEl.spellcheck = false;
    this.editorEl.placeholder = '输入 mermaid 图表源码，如 graph TD;\n  A-->B;';
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

  private async render(value: string): Promise<void> {
    const code = value.trim();
    if (!code) {
      this.renderEl.innerHTML = '<em class="typewren-math-error">空图表，选中它编辑源码</em>';
      return;
    }
    try {
      this.renderEl.innerHTML = await renderMermaidSvg(code);
    } catch (error) {
      this.renderEl.innerHTML = `<div class="typewren-math-error">${escapeHtml(String(error))}</div>`;
    }
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
    void this.render(next);
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
    this.dom.setAttribute('data-mermaid-value', nextNode.attrs.value as string);
    if (!this.dom.classList.contains('math-editing')) {
      void this.render(nextNode.attrs.value as string);
    }
    return true;
  }

  destroy(): void {
    this.dom.remove();
  }
}

export const mermaidBlockView = $view(mermaidBlockSchema.node, () => {
  return (node, view, getPos) => new MermaidBlockView(node, view, getPos);
});

/* ------------------------------------------------------------
 * 输入即转：用户敲 ```mermaid + Enter 先被 commonmark 建成
 * code_block(lang=mermaid)，本插件在 doc 变化时把它替换成图表节点
 * ------------------------------------------------------------ */
export const mermaidInputConvert = $prose(() => {
  return new Plugin({
    view(view: EditorView) {
      const convert = (): void => {
        const { state } = view;
        // 手动遍历顶层节点找 mermaid 代码块（TS 无法跟进 descendants 回调内的赋值）
        const doc = state.doc;
        const offsets: number[] = [];
        doc.forEach((_n, offset) => {
          offsets.push(offset);
        });
        let found: { from: number; to: number } | null = null;
        for (let i = 0; i < doc.childCount; i++) {
          const node = doc.child(i);
          if (
            node.type.name === 'code_block' &&
            (node.attrs as { language?: string | null }).language === 'mermaid'
          ) {
            found = { from: offsets[i], to: offsets[i] + node.nodeSize };
            break;
          }
        }
        if (found === null) return;

        const code = doc.textBetween(found.from + 1, found.to - 1, '\n');
        // $prose 插件内拿不到 ctx：直接经 schema.nodes 取节点类型
        const type = state.schema.nodes[MERMAID_NODE];
        if (!type) return;
        const node = type.create({ value: code });
        const tr = state.tr.replaceWith(found.from, found.to, node);
        tr.setSelection(NodeSelection.create(tr.doc, found.from));
        view.dispatch(tr);
      };
      return { update: convert };
    }
  });
});
