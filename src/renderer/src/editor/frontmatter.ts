import remarkFrontmatter from 'remark-frontmatter';

import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { NodeView } from '@milkdown/kit/prose/view';
import { $nodeSchema, $remark, $view } from '@milkdown/kit/utils';

/* ============================================================
 * YAML Front Matter（文档开头 `--- ... ---`）
 * 没有本支持时，frontmatter 会被 micromark 拆成 thematicBreak +
 * setext 标题混入正文（"keywords 行 + ---" 变成二级标题），
 * 同时污染大纲。remark-frontmatter 把它解析为 mdast `yaml` 节点
 * （parse 与 stringify 双向处理器都带，roundtrip 保真），
 * 本模块定义 frontmatter 节点并以 Typora 式键值表格展示。
 * 原子节点只读展示；修改内容需进入源码模式。
 * ============================================================ */

/** 挂载 remark-frontmatter（解析 `---` 元信息块为 yaml 节点）。
 * 必须显式配置 matter：默认参数 {} 不合法，会抛 "Missing `type` in matter" */
export const remarkFrontmatterPlugin = $remark('REMARK_FRONTMATTER', () => remarkFrontmatter, {
  type: 'yaml',
  marker: '-'
});

/** Front Matter 节点：mdast 类型是 yaml，PM 节点名 frontmatter（互不要求同名） */
export const frontmatterSchema = $nodeSchema('frontmatter', () => ({
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
      tag: 'div[data-frontmatter]',
      getAttrs: (dom) => ({
        value: (dom as HTMLElement).getAttribute('data-frontmatter') ?? ''
      })
    }
  ],
  toDOM: (node) => ['div', { 'data-frontmatter': node.attrs.value as string }],
  parseMarkdown: {
    match: ({ type }) => type === 'yaml',
    runner: (state, node, type) => {
      state.addNode(type, { value: (node.value as string) ?? '' });
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'frontmatter',
    runner: (state, node) => {
      state.addNode('yaml', undefined, node.attrs.value as string);
    }
  }
}));

class FrontmatterView implements NodeView {
  dom: HTMLElement;
  private body: HTMLElement;

  constructor(private node: ProseNode) {
    this.dom = document.createElement('div');
    this.dom.className = 'typewren-frontmatter';
    this.dom.setAttribute('contenteditable', 'false');
    this.body = document.createElement('div');
    this.body.className = 'frontmatter-body';
    this.dom.appendChild(this.body);
    this.render(node.attrs.value as string);
  }

  private render(value: string): void {
    const lines = value.replace(/\r\n/g, '\n').split('\n');
    this.body.textContent = '';
    for (const line of lines) {
      if (line.length === 0) continue;
      const row = document.createElement('div');
      row.className = 'frontmatter-line';
      // 原样排版 `key: value`（Typora 式卡片，不拆表格）
      row.textContent = line;
      this.body.appendChild(row);
    }
  }

  update(nextNode: ProseNode): boolean {
    if (nextNode.type !== this.node.type) return false;
    this.node = nextNode;
    this.render(nextNode.attrs.value as string);
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }
}

export const frontmatterView = $view(frontmatterSchema.node, () => {
  return (node) => new FrontmatterView(node);
});
