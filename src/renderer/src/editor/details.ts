import type { Root } from 'mdast';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { NodeView } from '@milkdown/kit/prose/view';
import { $nodeSchema, $remark, $view } from '@milkdown/kit/utils';

import { escapeHtml } from '../util/escape';
import { markdownExtensionPlugin } from './markdownExtension';
import type { MdNode } from './mdastTypes';

/* ============================================================
 * <details>/<summary> 折叠块（浏览器形式）
 * micromark 把 HTML 块 6（遇空行结束）拆成开标签/闭标签两个
 * 独立 html 节点，中间的正常 markdown（列表等）落在 details
 * 外面——折叠块只能点开空块、答案无法收起。
 * 本模块在 mdast 层把 `<details>...</details>` 对合并为单个
 * detailsHtml 节点（summary 抽到属性、中间节点收为 children）：
 * - 解析端：$nodeSchema('details') 容器节点（content: block+），
 *   ParserState.openNode/next/closeNode 还原子树——PM 内真正可
 *   编辑的折叠块（列表/段落/公式随意）；
 * - 序列化端：SerializerState.openNode 输出 detailsHtml mdast，
 *   自定义 handler 把 children 再用 markdown 序列化回
 *   `<details>\n<summary>…</summary>\n\n{内容}\n</details>`；
 *   handler 经 unified data('toMarkdownExtensions') 挂载——
 *   remark-stringify 的 compiler 在 stringify 时读取该 data，
 *   与 remark-frontmatter 同一机制（双向可用）。
 * NodeView：details 元素 + 静态 summary（contenteditable=false，
 * 原生点击收起/展开）+ contentDOM 接 PM 内容区（真正 WYSIWYG）。
 * ============================================================ */

/* ------------------------------------------------------------
 * mdast 层合并转换
 * ------------------------------------------------------------ */

const OPEN_RE = /^<\s*details([\s>]|$)/i;
const CLOSE_RE = /^<\s*\/\s*details\s*>/i;
const SUMMARY_RE = /^\s*<\s*summary[^>]*>(.*?)<\s*\/\s*summary\s*>\s*$/is;

/** 取 value 首行与其余行（开/闭标签判定只看行首） */
function splitFirstLine(value: string): [string, string] {
  const idx = value.indexOf('\n');
  if (idx === -1) return [value, ''];
  return [value.slice(0, idx), value.slice(idx + 1)];
}

/**
 * 提取节点的 HTML 围栏首行。兼容两种解析形态（实测 Milkdown 管线里
 * `<details>` 起头行有时被解析为段落内的 inline html，Node 侧直接
 * micromark 则是顶层 html 节点——两形态都认，且仅当段落里只有这一个
 * html 节点，绝不拆散含正文的段落）：
 * - 顶层 html 节点：value 首行
 * - 段落内唯一 html 节点：其 value 首行
 */
function htmlFence(node: MdNode): { first: string; rest: string; lines: string[] } | null {
  let value: string | undefined;
  if (node.type === 'html') {
    value = node.value;
  } else if (
    node.type === 'paragraph' &&
    Array.isArray(node.children) &&
    node.children.length === 1 &&
    node.children[0].type === 'html'
  ) {
    value = node.children[0].value;
  }
  if (typeof value !== 'string') return null;
  const [first, rest] = splitFirstLine(value);
  return { first, rest, lines: [first, ...rest.split('\n')] };
}

/**
 * 把 `<details>` 开标签节点 + 中间节点 + `</details>` 闭标签节点
 * 合并为单个 detailsHtml 节点（summary 抽到属性、中间收为 children）。
 * 无闭合对（含未闭合 details）的节点原样保留，走 rawHtml 展示。
 */
function mergeDetails(children: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  let i = 0;
  while (i < children.length) {
    const node = children[i];
    const fence = htmlFence(node);
    if (!fence || !OPEN_RE.test(fence.first)) {
      out.push(node);
      i++;
      continue;
    }
    // 找闭合标签（可能隔多个中间节点）
    let end = -1;
    for (let j = i + 1; j < children.length; j++) {
      const c = htmlFence(children[j]);
      if (c && CLOSE_RE.test(c.first)) {
        end = j;
        break;
      }
    }
    if (end === -1) {
      out.push(node);
      i++;
      continue;
    }

    // summary 抽取：开标签 value 的其余行中找 <summary>…</summary；
    // open 默认展开态：开标签行含属性 open（如 `<details open>`）时保留
    let summary = '';
    const headLines: string[] = [];
    for (const line of fence.lines.slice(1)) {
      const m = line.match(SUMMARY_RE);
      if (m) {
        summary = (m[1] ?? '').trim();
      } else if (line.trim().length > 0) {
        headLines.push(line);
      }
    }
    // 只认独立的 open 属性（`(?:^|\s)open(?=\s|=|>|$)`），data-open/opened 不算
    const open = /(?:^|\s)open(?:\s|=|>|$)/i.test(
      fence.first.replace(/^<\s*details/i, '')
    );

    const closeFence = htmlFence(children[end]);
    const closeRest = (closeFence?.lines.slice(1) ?? []).join('\n');

    const inner: MdNode[] = [];
    if (headLines.length > 0) inner.push({ type: 'html', value: headLines.join('\n') });
    inner.push(...children.slice(i + 1, end));
    if (closeRest.trim().length > 0) inner.push({ type: 'html', value: closeRest });

    out.push({ type: 'detailsHtml', summary, open, children: inner });
    i = end + 1;
  }
  return out;
}

/** mdast → markdown 的 detailsHtml 序列化处理器 */
const detailsMarkdownExtension = {
  handlers: {
    detailsHtml(
      node: Record<string, unknown>,
      _parent: unknown,
      state: unknown,
      info: unknown
    ): string {
    const n = node as unknown as { summary?: string; open?: boolean; children?: unknown[] };
    const summary = escapeHtml(String(n.summary ?? ''));
    // attrs.open 必须落回开标签——否则 <details open> 保存一次就丢默认展开态
    const openTag = n.open ? '<details open>' : '<details>';
    const body = (
      state as { containerFlow: (node: unknown, info: unknown) => string }
    ).containerFlow(node, info);
    if (!body.trim()) {
      return `${openTag}\n<summary>${summary}</summary>\n</details>`;
    }
    return `${openTag}\n<summary>${summary}</summary>\n\n${body}\n</details>`;
    }
  }
};

/**
 * $remark 插件：mdast 层合并 `<details>…</details>` 对。
 * 注意 unified 插件协议：use 时调用插件主体（this = processor），
 * 返回的函数才是 transformer。
 */
export const remarkDetailsPlugin = $remark('REMARK_DETAILS', () => {
  return function detailsMerge() {
    return function detailsMergeTransformer(tree: Root): void {
      // 集合重排：标准 mdast 节点 + 自定义 detailsHtml（类型系统无此节点，
      // 经 MdNode 宽松结构往返）
      tree.children = mergeDetails(
        tree.children as unknown as MdNode[]
      ) as unknown as Root['children'];
    };
  };
});

/** $remark 插件：挂载 detailsHtml 的 markdown 序列化 handler
 * （共享 markdownExtensionPlugin；写入时机要点见 markdownExtension.ts） */
export const detailsStringifyPlugin = markdownExtensionPlugin(
  'REMARK_DETAILS_STRINGIFY',
  detailsMarkdownExtension
);

/* ------------------------------------------------------------
 * Schema：容器节点（content: block+，summary 存属性）
 * ------------------------------------------------------------ */

export const detailsSchema = $nodeSchema('details', () => ({
  group: 'block',
  content: 'block+',
  defining: true,
  isolating: true,
  attrs: {
    summary: { default: '', validate: 'string' },
    open: { default: false, validate: 'boolean' }
  },
  parseDOM: [
    {
      tag: 'details.typewren-details',
      getAttrs: (dom) => ({
        summary: (dom as HTMLElement).getAttribute('data-summary') ?? '',
        open: (dom as HTMLElement).getAttribute('open') !== null
      })
    }
  ],
  // 导出用（编辑器走 NodeView）：summary 静态文本 + content 槽位——
  // 无槽位时 DOMSerializer 会让 details 的子内容静默丢失（导出回归）
  toDOM: (node) => [
    'details',
    {
      class: 'typewren-details',
      'data-summary': node.attrs.summary as string,
      ...((node.attrs.open as boolean) ? { open: '' } : {})
    },
    ['summary', {}, String(node.attrs.summary ?? '')],
    ['div', { class: 'typewren-details-body' }, 0]
  ],
  parseMarkdown: {
    match: ({ type }) => type === 'detailsHtml',
    runner: (state, node, type) => {
      const details = node as unknown as { summary?: string; open?: boolean };
      state.openNode(type, {
        summary: String(details.summary ?? ''),
        open: Boolean(details.open)
      });
      state.next(node.children);
      state.closeNode();
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'details',
    runner: (state, node) => {
      state.openNode('detailsHtml', undefined, {
        summary: node.attrs.summary as string,
        open: node.attrs.open as boolean
      });
      state.next(node.content);
      state.closeNode();
    }
  }
}));

/* ------------------------------------------------------------
 * NodeView：details + 静态 summary + PM 内容区
 * ------------------------------------------------------------ */

class DetailsView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private summaryEl: HTMLElement;

  constructor(private node: ProseNode) {
    const details = document.createElement('details');
    details.className = 'typewren-details';
    // 源文档 `<details open>` 的默认展开态保留
    if (node.attrs.open as boolean) details.open = true;
    this.summaryEl = document.createElement('summary');
    this.summaryEl.setAttribute('contenteditable', 'false');
    this.summaryEl.textContent = node.attrs.summary as string;
    const body = document.createElement('div');
    body.className = 'typewren-details-body';
    details.append(this.summaryEl, body);
    this.dom = details;
    this.contentDOM = body;
  }

  update(nextNode: ProseNode): boolean {
    if (nextNode.type !== this.node.type) return false;
    this.node = nextNode;
    this.summaryEl.textContent = nextNode.attrs.summary as string;
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }
}

export const detailsView = $view(detailsSchema.node, () => {
  return (node) => new DetailsView(node);
});
