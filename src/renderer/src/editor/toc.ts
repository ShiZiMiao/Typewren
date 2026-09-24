import type { EditorView, NodeView } from '@milkdown/kit/prose/view';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { NodeSelection, Plugin } from '@milkdown/kit/prose/state';
import { $nodeSchema, $prose, $remark, $view } from '@milkdown/kit/utils';

/* ============================================================
 * 目录（[TOC]）节点
 * - 解析：mdast 中恰好为 `[TOC]` 的段落 → 自定义类型（不干扰普通文本）；
 * - 展示：NodeView 收集文档标题渲染成嵌套列表，点击跳转；
 * - 文档变化时经 tocRefreshPlugin 通知所有 TOC 视图重建
 *   （标题改动时 TOC 节点自身不变，node view 的 update 不会触发）。
 * ============================================================ */

export const TOC_NODE = 'typewren_toc';

/** 模块级刷新注册表：doc 变化 → 所有 TOC 视图重建 */
const refreshListeners = new Set<() => void>();

export const tocRefreshPlugin = $prose(() => {
  return new Plugin({
    view(view: EditorView) {
      return {
        update: (_view, prevState) => {
          // 只在文档内容变化时通知（选区移动不重建，省去无谓 DOM 抖动）
          if (!prevState.doc.eq(view.state.doc)) {
            for (const refresh of refreshListeners) refresh();
          }
        }
      };
    }
  });
});

/** [TOC] 段落 → 自定义 mdast 类型。
 * 注意 $remark 工厂须返回**插件**（(options) => transformer），
 * 直接返回 transformer 会被当插件调用、转换体永不执行。 */
export const remarkTocPlugin = $remark('TOC_REMARK', () => {
  return () => {
    return (tree: unknown) => {
      const visit = (node: Record<string, unknown>): void => {
        const children = node.children;
        if (node.type === 'paragraph' && Array.isArray(children) && children.length === 1) {
          const first = children[0] as Record<string, unknown>;
          if (first.type === 'text' && first.value === '[TOC]') {
            node.type = TOC_NODE;
          }
        }
        if (Array.isArray(children)) {
          for (const child of children) visit(child as Record<string, unknown>);
        }
      };
      visit(tree as Record<string, unknown>);
    };
  };
});

/** Schema：块级原子节点 */
export const tocSchema = $nodeSchema(TOC_NODE, () => ({
  group: 'block',
  atom: true,
  selectable: true,
  defining: true,
  isolating: true,
  parseDOM: [
    {
      tag: 'div[data-type="typewren_toc"]',
      getAttrs: () => ({})
    }
  ],
  toDOM: () => ['div', { class: 'typewren-toc', 'data-type': 'typewren_toc' }],
  parseMarkdown: {
    match: ({ type }) => type === TOC_NODE,
    runner: (state, _node, type) => {
      state.addNode(type, {});
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === TOC_NODE,
    runner: (state) => {
      state.addNode('paragraph', [{ type: 'text', value: '[TOC]' }]);
    }
  }
}));

interface TocHeading {
  level: number;
  text: string;
  pos: number;
}

/** 收集文档标题（level + text + pos），TOC 视图中枢 */
export function collectTocHeadings(doc: ProseNode): TocHeading[] {
  const headings: TocHeading[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      headings.push({ level: Number(node.attrs.level), text: node.textContent.trim(), pos });
    }
    return true;
  });
  return headings;
}

/** 渲染标题嵌套列表（编辑器与导出共用） */
export function renderTocList(doc: ProseNode, onClick?: (pos: number) => void): HTMLElement {
  const root = document.createElement('nav');
  root.className = 'toc-list';
  const headings = collectTocHeadings(doc);
  if (headings.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'toc-empty';
    empty.textContent = '暂无标题，使用 # 创建后自动更新';
    root.appendChild(empty);
    return root;
  }

  const rootUl = document.createElement('ul');
  root.appendChild(rootUl);

  // 栈式嵌套：栈顶条目记录该层级最近的 li——层级"跳深再回落"（h1→h3→h2）
  // 时新嵌套 ul 必须挂在栈内对应层级的 li 下；用全局 lastLi 会挂到上一条
  // （h3 的 li）上，层级错乱
  const stack: { level: number; ul: HTMLUListElement; li: HTMLLIElement | null }[] = [
    { level: headings[0].level, ul: rootUl, li: null }
  ];

  for (const heading of headings) {
    while (stack.length > 1 && heading.level < stack[stack.length - 1].level) {
      stack.pop();
    }
    const top = stack[stack.length - 1];
    if (heading.level > top.level) {
      const deeper = document.createElement('ul');
      (top.li ?? top.ul).appendChild(deeper);
      stack.push({ level: heading.level, ul: deeper, li: null });
    }

    const li = document.createElement('li');
    const a = document.createElement('button');
    a.type = 'button';
    a.className = 'toc-item';
    a.textContent = heading.text;
    a.title = heading.text;
    if (onClick) {
      a.addEventListener('click', () => onClick(heading.pos));
    }
    li.appendChild(a);
    const current = stack[stack.length - 1];
    current.ul.appendChild(li);
    current.li = li;
  }
  return root;
}

/* ------------------------------------------------------------
 * NodeView：渲染 TOC 列表，点击跳转到标题
 * ------------------------------------------------------------ */
class TocView implements NodeView {
  dom: HTMLElement;
  private hintEl: HTMLElement;
  private lastSignature = '';

  private refresh = (): void => {
    this.rebuild();
  };

  constructor(private readonly view: EditorView) {
    this.dom = document.createElement('div');
    this.dom.className = 'typewren-toc';
    this.dom.setAttribute('data-type', 'typewren_toc');

    this.hintEl = document.createElement('span');
    this.hintEl.className = 'toc-hint';
    this.hintEl.textContent = '[TOC]';
    this.dom.appendChild(this.hintEl);

    this.rebuild();
    refreshListeners.add(this.refresh);
  }

  private rebuild(): void {
    const headings = collectTocHeadings(this.view.state.doc);
    const signature = headings.map((h) => `${h.level}:${h.text}`).join('\n');
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    const list = renderTocList(this.view.state.doc, (pos) => this.jump(pos));
    // 保留 [TOC] 角标提示（视觉上说明这是"目录"而非普通列表）
    this.dom.insertBefore(list, this.hintEl);
    // 移除旧列表
    for (const child of Array.from(this.dom.childNodes)) {
      if (child !== this.hintEl && child !== list) child.remove();
    }
  }

  private jump(pos: number): void {
    const { state } = this.view;
    if (pos < 0 || pos >= state.doc.content.size) return;
    const sel = NodeSelection.create(state.doc, pos);
    this.view.dispatch(state.tr.setSelection(sel).scrollIntoView());
    this.view.focus();
  }

  update(): boolean {
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    refreshListeners.delete(this.refresh);
    this.dom.remove();
  }
}

export const tocView = $view(tocSchema.node, () => {
  return (_node, view) => new TocView(view);
});

/** 用于导出的占位替换：把序列化出的 .typewren-toc 空 div 填成标题列表（无交互） */
export function fillExportToc(root: HTMLElement, doc: ProseNode): void {
  root.querySelectorAll<HTMLElement>('.typewren-toc').forEach((el) => {
    el.replaceChildren(renderTocList(doc));
  });
}
