import type { Editor } from '@milkdown/kit/core';
import { parserCtx } from '@milkdown/kit/core';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';

/* ============================================================
 * Docx 结构化导出：把 Markdown（经编辑器 parser 重解析）转成
 * 平台无关的结构化 JSON，主进程用 npm 'docx' 库生成 .docx。
 * 覆盖：标题/段落/行内格式（粗斜体行内代码链接删除线）/列表
 * （有序/无序/任务）/表格/代码块/引用/分割线/公式与图表占位。
 * ============================================================ */

export interface DocxText {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  underline?: boolean;
  href?: string;
}

export interface DocxParagraph {
  type: 'paragraph';
  runs: DocxText[];
  bullet?: 'ordered' | 'bullet' | 'task';
  level: number;
  checked?: boolean;
  quote?: boolean;
}

export interface DocxHeading {
  type: 'heading';
  level: number;
  runs: DocxText[];
}

export interface DocxCode {
  type: 'code';
  text: string;
  language?: string;
}

export interface DocxTable {
  type: 'table';
  rows: DocxText[][][];
  header: boolean;
}

export interface DocxRaw {
  type: 'raw';
  text: string;
}

export interface DocxRule {
  type: 'rule';
}

export interface DocxToc {
  type: 'toc';
}

export type DocxBlock =
  DocxParagraph | DocxHeading | DocxCode | DocxTable | DocxRaw | DocxRule | DocxToc;

export interface DocxDoc {
  blocks: DocxBlock[];
}

/** 收集 textblock 的行内文本（含 marks） */
function extractRuns(node: ProseNode): DocxText[] {
  const runs: DocxText[] = [];
  node.descendants((child) => {
    if (child.isText) {
      const markOf = (name: string): boolean => child.marks.some((m) => m.type.name === name);
      const link = child.marks.find((m) => m.type.name === 'link');
      runs.push({
        text: child.text ?? '',
        bold: markOf('strong') || markOf('bold'),
        italic: markOf('emphasis') || markOf('italic'),
        strike: markOf('strike_through'),
        code: markOf('inline_code'),
        underline: markOf('underline'),
        href: typeof link?.attrs.href === 'string' ? link.attrs.href : undefined
      });
    }
    return true;
  });
  return runs;
}

/** 递归遍历：ancestors 为祖先链（根在最前），visit 返回 false 停止下探 */
function walk(
  node: ProseNode,
  ancestors: ProseNode[],
  visit: (n: ProseNode, anc: ProseNode[]) => boolean
): void {
  if (!visit(node, ancestors)) return;
  node.forEach((child) => {
    walk(child, [...ancestors, node], visit);
  });
}

/** 祖先链上最近的指定类型下标；无则 -1 */
function lastAncestorIndexByType(ancestors: ProseNode[], type: string): number {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (ancestors[i].type.name === type) return i;
  }
  return -1;
}

/** 列表嵌套深度：list_item 祖先数（1 级 = level 0） */
function indentLevel(ancestors: ProseNode[]): number {
  let depth = 0;
  for (const anc of ancestors) {
    if (anc.type.name === 'list_item') depth += 1;
  }
  return Math.max(0, depth - 1);
}

/** 单元格内容：一个 table_cell 内可能多个段落，拼成 run 序列 */
function extractCellRuns(cell: ProseNode): DocxText[] {
  const runs: DocxText[] = [];
  cell.forEach((p) => {
    if (p.isTextblock) runs.push(...extractRuns(p));
  });
  return runs;
}

function extractBlocks(doc: ProseNode): DocxBlock[] {
  const blocks: DocxBlock[] = [];

  walk(doc, [], (node, ancestors) => {
    const name = node.type.name;

    if (name === 'heading') {
      blocks.push({ type: 'heading', level: Number(node.attrs.level), runs: extractRuns(node) });
      return false;
    }

    if (name === 'paragraph') {
      const liIdx = lastAncestorIndexByType(ancestors, 'list_item');
      if (liIdx >= 0) {
        const listType = ancestors[liIdx - 1]?.type.name === 'ordered_list' ? 'ordered' : 'bullet';
        const checked = (ancestors[liIdx].attrs as { checked?: boolean }).checked;
        const isTask = typeof checked === 'boolean';
        blocks.push({
          type: 'paragraph',
          runs: extractRuns(node),
          bullet: isTask ? 'task' : listType,
          level: indentLevel(ancestors),
          checked
        });
      } else {
        blocks.push({
          type: 'paragraph',
          runs: extractRuns(node),
          level: 0,
          quote: ancestors.some((a) => a.type.name === 'blockquote')
        });
      }
      return false;
    }

    if (name === 'code_block') {
      blocks.push({
        type: 'code',
        text: node.textContent,
        language: (node.attrs as { language?: string }).language ?? undefined
      });
      return false;
    }

    if (name === 'table') {
      const rows: DocxText[][][] = [];
      node.forEach((row) => {
        if (row.type.name !== 'table_row') return;
        const cells: DocxText[][] = [];
        row.forEach((cell) => {
          if (cell.type.name === 'table_cell') cells.push(extractCellRuns(cell));
        });
        rows.push(cells);
      });
      blocks.push({ type: 'table', rows, header: true });
      return false;
    }

    if (name === 'math' || name === 'inline_math') {
      blocks.push({ type: 'raw', text: `$$${node.attrs.value}$$` });
      return false;
    }

    if (name === 'typewren_mermaid') {
      blocks.push({ type: 'raw', text: '```mermaid\n' + (node.attrs.value as string) + '\n```' });
      return false;
    }

    if (name === 'typewren_toc') {
      blocks.push({ type: 'toc' });
      return false;
    }

    if (name === 'image') {
      blocks.push({
        type: 'raw',
        text: `![${node.attrs.alt ?? ''}](${node.attrs.src ?? ''})`
      });
      return false;
    }

    if (name === 'hr') {
      blocks.push({ type: 'rule' });
      return false;
    }

    // 其它容器节点（doc/list_item/blockquote/table 等）：继续向下
    if (node.isTextblock) {
      blocks.push({ type: 'paragraph', runs: extractRuns(node), level: 0 });
      return false;
    }
    return true;
  });

  return blocks;
}

/** 把当前 Markdown 经编辑器 parser 重解析为 docx 结构化 JSON */
export function buildDocxDoc(editor: Editor, markdown: string): DocxDoc {
  const doc: ProseNode = editor.action((ctx) => ctx.get(parserCtx)(markdown));
  return { blocks: extractBlocks(doc) };
}
