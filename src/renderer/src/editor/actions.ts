import { editorViewCtx, parserCtx, serializerCtx, type Editor } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { setBlockType, toggleMark, wrapIn } from '@milkdown/kit/prose/commands';
import type { EditorView } from '@milkdown/kit/prose/view';
import { insert, replaceAll } from '@milkdown/kit/utils';

import { mathBlockSchema, mathInlineSchema } from './math';
import { escapeTracking } from './strikethroughFix';
import { NodeSelection } from '@milkdown/kit/prose/state';
import { promptDialog } from '../ui/promptDialog';
import { isSafeLinkHref } from '../util/link';

/* ============================================================
 * 编辑器命令封装：菜单 / 快捷键统一从这里调用
 * 全部基于 ProseMirror 官方 commands + Milkdown insert 宏，
 * 不依赖具体 preset 导出的不稳定 API。
 * ============================================================ */

/**
 * 将当前文档序列化为 Markdown 字符串。
 *
 * 序列化使用“放宽转义”的 text handler（见 strikethroughFix.ts）：
 * 凡去转义后重解析仍是同一文本节点的内容一律原样输出（foo_bar 不会变成
 * foo\_bar）。若放宽过程真的去掉了转义，则回读校验文本内容未变——
 * 逐节点校验已挡住 _a_、行首 # 等结构级误读；这里的回读兜底挡住跨节点
 * 的字符合并（如字面 a~~b 与后文删除线拼成 a~~b~~c~~ 会吞掉内容），
 * 判据用 textContent 而非结构全等：Milkdown 对引用块/列表等结构的
 * 序列化往返存在正常差异，结构全等会把整个文档误判为不兼容而退回
 * 全篇转义。
 */
export function getMarkdown(editor: Editor): string {
  return editor.action((ctx) => {
    const doc = ctx.get(editorViewCtx).state.doc;
    const serialize = () => ctx.get(serializerCtx)(doc);

    escapeTracking.strict = false;
    escapeTracking.relaxed = false;
    let markdown = serialize();

    if (escapeTracking.relaxed) {
      escapeTracking.strict = true;
      try {
        const reparsed = ctx.get(parserCtx)(markdown);
        if (reparsed.textContent !== doc.textContent) markdown = serialize();
      } finally {
        escapeTracking.strict = false;
      }
    }
    return markdown;
  });
}

/** 用新的 Markdown 内容整体替换文档（打开文件时使用） */
export function setMarkdown(editor: Editor, markdown: string): void {
  editor.action(replaceAll(markdown));
}

function withView(editor: Editor, fn: (view: EditorView) => void): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    fn(view);
    view.focus();
  });
}

/* ---------------- 行内格式 ---------------- */

export function toggleTextMark(editor: Editor, markName: string): void {
  withView(editor, (view) => {
    const markType = view.state.schema.marks[markName];
    if (!markType) return;
    toggleMark(markType)(view.state, view.dispatch, view);
  });
}

/* ---------------- 标题与块级转换 ---------------- */

export function setHeadingLevel(editor: Editor, level: number): void {
  withView(editor, (view) => {
    const schema = view.state.schema;

    if (level <= 0) {
      setBlockType(schema.nodes.paragraph)(view.state, view.dispatch, view);
      return;
    }

    if (schema.nodes.heading) {
      setBlockType(schema.nodes.heading, { level })(view.state, view.dispatch, view);
    }
  });
}

export function wrapInListKind(editor: Editor, kind: 'bullet' | 'ordered'): void {
  withView(editor, (view) => {
    const schema = view.state.schema;
    const listNode = kind === 'bullet' ? schema.nodes.bullet_list : schema.nodes.ordered_list;
    if (!listNode) return;
    wrapIn(listNode)(view.state, view.dispatch, view);
  });
}

export function toggleBlockquote(editor: Editor): void {
  withView(editor, (view) => {
    const blockquote = view.state.schema.nodes.blockquote;
    if (!blockquote) return;
    wrapIn(blockquote)(view.state, view.dispatch, view);
  });
}

export function makeCodeBlock(editor: Editor): void {
  withView(editor, (view) => {
    const codeBlock = view.state.schema.nodes.code_block;
    if (!codeBlock) return;
    setBlockType(codeBlock, { language: '' })(view.state, view.dispatch, view);
  });
}

/* ---------------- 插入类 ---------------- */

/** 在光标处插入原始 Markdown 片段（图片粘贴/拖拽等场景复用） */
export function insertMarkdown(editor: Editor, markdown: string): void {
  editor.action(insert(markdown));
  editor.action((ctx) => ctx.get(editorViewCtx).focus());
}

export function insertHr(editor: Editor): void {
  insertMarkdown(editor, '\n---\n');
}

export function insertTable(editor: Editor): void {
  const table = [
    '| 列一 | 列二 | 列三 |',
    '| --- | --- | --- |',
    '| 内容 | 内容 | 内容 |',
    '| 内容 | 内容 | 内容 |',
    ''
  ].join('\n');

  insertMarkdown(editor, table);
}

export function insertTaskItem(editor: Editor): void {
  insertMarkdown(editor, '\n- [ ] 任务\n');
}

/**
 * 在光标处插入一个可选中的原子节点（公式用），并立即进入其源码编辑状态。
 * replaceSelectionWith 对可选择的原子节点会自动产生 NodeSelection；
 * 兜底分支对 selection.from - node.nodeSize 做下限钳制，防止插入位置在文档开头时算负。
 */
function insertMathNode(editor: Editor, createNode: (ctx: Ctx) => ProseNode | null): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const node = createNode(ctx);
    if (!node) return;

    const tr = view.state.tr.replaceSelectionWith(node);
    if (!(tr.selection instanceof NodeSelection)) {
      const pos = Math.max(0, tr.selection.from - node.nodeSize);
      tr.setSelection(NodeSelection.create(tr.doc, pos));
    }
    view.dispatch(tr);
  });
  editor.action((ctx) => ctx.get(editorViewCtx).focus());
}

/** 插入空块级公式并立即进入源码编辑状态 */
export function insertMathBlock(editor: Editor): void {
  insertMathNode(editor, (ctx) => mathBlockSchema.type(ctx).create({ value: '' }));
}

export async function insertOrUpdateLink(editor: Editor): Promise<void> {
  // 循环收集地址：拒绝不安全的协议（javascript:/data: 等防注入），
  // 允许相对路径 / 锚点；取消则整体退出
  let target = '';
  for (;;) {
    const href = await promptDialog({
      title: '插入链接',
      label: '链接地址（http/https，或相对路径）',
      defaultValue: target || 'https://',
      confirmText: '下一步'
    });
    if (href === null) return;
    target = href.trim();
    if (target.length === 0) return;
    if (isSafeLinkHref(target)) break;
    await promptDialog({
      title: '链接地址无效',
      label: '仅支持 http/https/mailto 链接或相对路径，请重新输入',
      confirmText: '知道了'
    });
  }

  let selectionEmpty = true;
  editor.action((ctx) => {
    selectionEmpty = ctx.get(editorViewCtx).state.selection.empty;
  });

  if (selectionEmpty) {
    const text = await promptDialog({
      title: '链接文字',
      label: '链接文字',
      defaultValue: '链接'
    });
    if (text === null || text.trim().length === 0) return;
    insertMarkdown(editor, `[${text}](${target})`);
    return;
  }

  withView(editor, (view) => {
    const linkType = view.state.schema.marks.link;
    if (!linkType) return;
    toggleMark(linkType, { href: target })(view.state, view.dispatch, view);
  });
}

export async function insertImage(editor: Editor): Promise<void> {
  const src = await promptDialog({
    title: '插入图片',
    label: '图片地址',
    defaultValue: 'https://'
  });
  if (!src || src.trim().length === 0 || src.trim() === 'https://') return;
  const target = src.trim();

  const alt = await promptDialog({
    title: '图片替代文字',
    label: '替代文字（可选）',
    defaultValue: ''
  });
  if (alt === null) return;
  insertMarkdown(editor, `![${alt}](${target})`);
}

/** 在光标处插入一个行内公式节点 */
export function insertMathInline(editor: Editor): void {
  insertMathNode(editor, (ctx) => mathInlineSchema.type(ctx).create({ value: '' }));
}
