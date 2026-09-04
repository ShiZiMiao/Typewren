import { parser as lezerMarkdownParser, GFM, type MarkdownParser } from '@lezer/markdown';
import { lowlight } from '../editor/highlight';

/* ============================================================
 * 源码模式 Markdown 语法高亮（CSS Custom Highlight API）
 *
 * 源码视图是 contenteditable div：不能往 DOM 里插高亮 span（会破坏
 * 光标/选区与文本流）。这里用 @lezer/markdown（CodeMirror 6 的
 * Markdown 解析内核，纯 JS）对 Markdown 建语法树，把有意义的结构
 * 节点映射为非重叠的文本区间 [start,end)，注册到 CSS.highlights，
 * 由 CSS ::highlight() 规则着色——文本节点保持原样，编辑完全无感。
 *
 * 代码块内容（CodeText）另用 lowlight(highlight.js) 按内嵌语言分词，
 * 与编辑器代码块高亮同源；纯文本段不产生任何 token（正确的不着色语义）。
 *
 * 注意：CSS Highlights 仅支持 color / background / text-decoration /
 * text-shadow 等少量属性，font-weight/font-style 无效，视觉表达靠颜色。
 * ============================================================ */

/** 高亮名前缀（CSS.highlights 全局注册表，用前缀隔离） */
export const SOURCE_HL_PREFIX = 'typewren-source-';

/** GFM 扩展（表格/任务/删除线），必须 configure 注入且模块级只做一次 */
const gfmParser: MarkdownParser = lezerMarkdownParser.configure(GFM);

/**
 * lezer 节点名 → 归一化类名映射。
 * 未列出的节点（Paragraph/TableCell 等容器、Escape/Entity）不着色：
 * 纯文本段是"无结构"的正确语义，转义字符不应伪装成结构。
 */
const NODE_CLASS: Record<string, string> = {
  // 标题整段
  ATXHeading1: 'section',
  ATXHeading2: 'section',
  ATXHeading3: 'section',
  ATXHeading4: 'section',
  ATXHeading5: 'section',
  ATXHeading6: 'section',
  SetextHeading1: 'section',
  SetextHeading2: 'section',
  // 引用：整块（含行内内容）淡色
  Blockquote: 'quote',
  QuoteMark: 'quote',
  // 列表符（- / 1. 等标记本身）
  ListMark: 'bullet',
  // 强调/加粗：`**粗体**` 的标记着色、正文上背景；`*斜*` 整体着色
  StrongEmphasis: 'strong',
  Emphasis: 'emphasis',
  EmphasisMark: 'emphasis',
  // 行内代码（含反引号）
  InlineCode: 'code',
  CodeMark: 'code',
  // 代码围栏：整块作 code-block 底色，围栏符由 CodeMark 覆盖
  FencedCode: 'code-block',
  CodeBlock: 'code-block',
  CodeInfo: 'code-block',
  // CodeText 特殊处理：整段 code-block + 内嵌语言分词（见 emitCodeText）
  // 链接：整段（含角标/URL）link 色，链接标签/标题 string 色
  Link: 'link',
  Autolink: 'link',
  Image: 'link',
  LinkMark: 'link',
  URL: 'link',
  LinkReference: 'link',
  LinkLabel: 'string',
  LinkTitle: 'string',
  // 删除线：带线删除样式（新增）
  Strikethrough: 'strikethrough',
  StrikethroughMark: 'strikethrough',
  // 表格分隔符（| 与分隔行）淡色；单元格内容不着色
  TableDelimiter: 'table',
  // 任务勾选标记 [x] / [ ]
  TaskMarker: 'task',
  // 其余装饰性节点
  HorizontalRule: 'meta',
  HTMLBlock: 'code-block',
  HTMLTag: 'meta',
  HardBreak: 'meta',
  Comment: 'comment',
  CommentBlock: 'comment',
  ProcessingInstruction: 'meta'
};

/** 具备专属配色的 hljs 类（代码块内嵌语言分词复用）；其余归 code-block 风格 */
const STYLE_CLASSES = new Set([
  'section',
  'title',
  'bullet',
  'quote',
  'strong',
  'emphasis',
  'code',
  'code-block',
  'link',
  'string',
  'meta',
  'comment',
  'number',
  'keyword',
  'literal',
  'attribute',
  'built_in',
  'attr',
  'variable',
  'regexp',
  'symbol',
  'type',
  'punctuation',
  'formula'
]);

export interface SourceToken {
  start: number;
  end: number;
  /** 归一化后的醒目类名（无样式类时为 null） */
  cls: string | null;
}

function normalizeClass(className: string | null): string | null {
  if (!className) return null;
  const match = /^hljs-([a-z0-9_-]+)$/.exec(className);
  if (!match) return null;
  const name = match[1];
  return STYLE_CLASSES.has(name) ? name : 'code-block';
}

/** lezer 语法树节点的最小结构（避免直接依赖 @lezer/common 类型） */
interface TreeNode {
  name: string;
  from: number;
  to: number;
  cursor(): {
    firstChild(): boolean;
    nextSibling(): boolean;
    node: TreeNode;
  };
}

function childrenOf(node: TreeNode): TreeNode[] {
  const out: TreeNode[] = [];
  const cur = node.cursor();
  if (cur.firstChild()) {
    do {
      out.push(cur.node);
    } while (cur.nextSibling());
  }
  return out;
}

/**
 * 用 @lezer/markdown（GFM 配置）对 Markdown 文本建树并分词，
 * 返回 [start,end) 的源码区间。输出为互不重叠的 token：
 * 结构节点整体成 token，内部有不同类的子节点时按子节点边界"雕刻"
 * （与旧 hljs 非重叠语义一致），间隙用父类填充。
 */
export function tokenizeSource(text: string): SourceToken[] {
  if (text.length === 0) return [];

  let tree: ReturnType<typeof gfmParser.parse>;
  try {
    tree = gfmParser.parse(text);
  } catch {
    return [];
  }

  const tokens: SourceToken[] = [];
  const push = (start: number, end: number, cls: string | null): void => {
    if (cls && start < end) tokens.push({ start, end, cls });
  };

  /** 子树是否只包含与 cls 相同的样式或纯文本（是则无需递归，由外围填充覆盖） */
  const isUniform = (node: TreeNode, cls: string | null): boolean => {
    if (node.name === 'CodeText') return false; // 内嵌语言分词会产生其它类
    const own = NODE_CLASS[node.name];
    if (own !== undefined && own !== cls) return false;
    for (const child of childrenOf(node)) {
      if (!isUniform(child, cls)) return false;
    }
    return true;
  };

  /** 围栏语言：CodeInfo 第一个词；缩进代码块无 CodeInfo → markdown */
  const fenceLangOf = (node: TreeNode): string => {
    for (const child of childrenOf(node)) {
      if (child.name === 'CodeInfo') {
        const info = text.slice(child.from, child.to).trim().split(/\s+/)[0];
        return info || 'markdown';
      }
    }
    return 'markdown';
  };

  /** 代码文本：整段 code-block 兜底 + 内嵌语言分词（区间加全局偏移） */
  const emitCodeText = (node: TreeNode, lang: string): void => {
    const from = node.from;
    const code = text.slice(from, node.to);
    push(from, node.to, 'code-block');
    let tree2: ReturnType<typeof lowlight.highlight>;
    try {
      tree2 = lowlight.highlight(lang, code);
    } catch {
      return; // 内嵌分词失败：保留 code-block 兜底
    }

    let offset = 0;
    const walk = (
      n: {
        type: string;
        value?: string;
        children?: unknown[];
        properties?: { className?: unknown };
      },
      inheritedCls: string | null
    ): void => {
      if (n.type === 'text') {
        const value = n.value ?? '';
        if (value.length > 0) {
          push(from + offset, from + offset + value.length, inheritedCls);
        }
        offset += value.length;
        return;
      }
      let ownCls = inheritedCls;
      if (n.type === 'element' && Array.isArray(n.properties?.className)) {
        const first = String((n.properties!.className as string[])[0]);
        ownCls = normalizeClass(first) ?? inheritedCls;
      }
      for (const child of (n.children ?? []) as {
        type: string;
        value?: string;
        children?: unknown[];
        properties?: { className?: unknown };
      }[]) {
        walk(child, ownCls);
      }
    };
    walk(tree2, null);
  };

  const emit = (node: TreeNode, inherited: string | null, lang: string): void => {
    const own = NODE_CLASS[node.name];
    const cls = own !== undefined ? own : inherited;

    if (node.name === 'CodeText') {
      emitCodeText(node, lang);
      return;
    }

    const kids = childrenOf(node);
    if (kids.length === 0) {
      push(node.from, node.to, cls);
      return;
    }

    // 围栏/缩进代码块：语言信息要传给 CodeText 兄弟节点
    let childLang = lang;
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
      childLang = fenceLangOf(node);
    }

    let pos = node.from;
    for (const child of kids) {
      if (isUniform(child, cls)) continue; // 同类或纯文本 → 由间隙填充覆盖
      if (cls && child.from > pos) push(pos, child.from, cls);
      emit(child, cls, childLang);
      pos = child.to;
    }
    if (cls && pos < node.to) push(pos, node.to, cls);
  };

  emit(tree.topNode, null, 'markdown');
  return tokens;
}

/**
 * 把 token 区间映射为源码编辑区里的 Range 列表（按类名分组）。
 * 文本流校验失败（存在 <br> 等非文本节点导致偏移失真）时返回空，
 * 调用方安全降级为纯文本显示。
 */
export function tokensToRanges(el: HTMLElement, tokens: SourceToken[]): Map<string, Range[]> {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  const nodeOffsets: number[] = [];
  let cursor = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    textNodes.push(node);
    nodeOffsets.push(cursor);
    cursor += node.data.length;
  }

  if (el.textContent === null || el.textContent.length !== cursor) {
    return new Map();
  }
  if (textNodes.length === 0) return new Map();

  const groups = new Map<string, Range[]>();
  for (const token of tokens) {
    if (!token.cls || token.start < 0 || token.end > cursor || token.start >= token.end) {
      continue;
    }

    // 定位起始文本节点（线性推进）
    let i = 0;
    while (i < textNodes.length && nodeOffsets[i] + textNodes[i].data.length <= token.start) {
      i++;
    }
    if (i >= textNodes.length) continue;
    const startNode = textNodes[i];
    const startOffset = token.start - nodeOffsets[i];

    // 定位结束文本节点（token 末端所在；区间可跨多个节点）
    let j = i;
    while (j < textNodes.length && nodeOffsets[j] < token.end) j++;
    const endIdx = Math.min(j - 1, textNodes.length - 1);
    const endNode = textNodes[endIdx];
    const endOffset =
      Math.min(token.end, nodeOffsets[endIdx] + endNode.data.length) - nodeOffsets[endIdx];

    if (startOffset > startNode.data.length) continue;

    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const list = groups.get(token.cls);
    if (list) list.push(range);
    else groups.set(token.cls, [range]);
  }
  return groups;
}

/** 清空源码模式注册的全部高亮 */
export function clearSourceHighlight(): void {
  const registry = CSS.highlights;
  const stale: string[] = [];
  for (const name of registry.keys()) {
    if (name.startsWith(SOURCE_HL_PREFIX)) stale.push(name);
  }
  for (const name of stale) registry.delete(name);
}

/** 对源码编辑区当前内容重新分词并注册高亮（失败时静默保持纯文本） */
export function applySourceHighlight(el: HTMLElement, text: string): void {
  try {
    clearSourceHighlight();
    const tokens = tokenizeSource(text);
    const groups = tokensToRanges(el, tokens);
    for (const [cls, ranges] of groups) {
      if (ranges.length > 0) {
        CSS.highlights.set(`${SOURCE_HL_PREFIX}${cls}`, new Highlight(...ranges));
      }
    }
  } catch {
    // CSS Highlight API 不可用：源码模式仍是纯文本，不影响编辑
  }
}
