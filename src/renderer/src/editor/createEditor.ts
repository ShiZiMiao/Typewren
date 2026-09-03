import {
  defaultValueCtx,
  Editor,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx
} from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm, tableSchema } from '@milkdown/kit/preset/gfm';
import { Plugin } from '@milkdown/kit/prose/state';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView, NodeView } from '@milkdown/kit/prose/view';
import { history } from '@milkdown/kit/plugin/history';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { trailing } from '@milkdown/kit/plugin/trailing';
import { cursor } from '@milkdown/kit/plugin/cursor';
import { $prose, $view } from '@milkdown/kit/utils';

import { highlight, configureCodeHighlight } from './highlight';
import { applyStrikethroughFixes } from './strikethroughFix';
import {
  blockMathEmptyInputRule,
  blockMathFullInputRule,
  inlineMathInputRule,
  mathBlockSchema,
  mathBlockView,
  mathInlineSchema,
  mathInlineView,
  remarkMathPlugin
} from './math';
import { tableTools } from './tableTools';
import { taskListToggle } from './taskToggle';

/* ============================================================
 * Typewren 编辑器装配
 * 单栏所见即所得由 Milkdown(ProseMirror) 原生提供：
 * 输入规则即时转换语法 → 渲染态展示；仅选中节点临时可编辑。
 * ============================================================ */

export interface ViewChangeKind {
  kind: 'doc' | 'selection';
}

export interface CreateEditorOptions {
  /** 编辑器挂载点 */
  root: HTMLElement;
  /** 初始 Markdown 内容 */
  initialMarkdown: string;
  /** 文档内容变化（已序列化为 Markdown）——用于脏状态检测 */
  onMarkdownUpdated: (markdown: string) => void;
  /** 视图变化 —— 用于状态栏与大纲联动 */
  onViewChanged: (change: ViewChangeKind) => void;
  /**
   * 粘贴拦截（可选）：返回 true 表示已处理（如图片落盘），
   * 不再交给 ProseMirror 默认行为。
   */
  onPaste?: (event: ClipboardEvent) => boolean;
}

export interface EditorInstance {
  editor: Editor;
  view(): EditorView;
  focus(): void;
}

export async function createEditor(options: CreateEditorOptions): Promise<EditorInstance> {
  /** 文档 / 选区变化通知插件 */
  const viewEvents = $prose(() => {
    return new Plugin({
      view(_view: EditorView) {
        const notify = (current: EditorView['state'], previous: EditorView['state']): void => {
          if (!previous.doc.eq(current.doc)) {
            options.onViewChanged({ kind: 'doc' });
          } else if (!previous.selection.eq(current.selection)) {
            options.onViewChanged({ kind: 'selection' });
          }
        };
        return {
          update(view: EditorView, prevState: EditorView['state']): void {
            notify(view.state, prevState);
          }
        };
      }
    });
  });

  /** 空文档占位提示 */
  const emptyDocPlaceholder = $prose(() => {
    return new Plugin({
      view(view: EditorView) {
        const apply = (v: EditorView): void => {
          const doc = v.state.doc;
          const isEmpty =
            doc.childCount === 0 ||
            (doc.childCount === 1 &&
              doc.firstChild?.type.name === 'paragraph' &&
              doc.firstChild.textContent.length === 0);
          v.dom.classList.toggle('is-doc-empty', isEmpty);
        };

        apply(view);
        return {
          update(v: EditorView): void {
            apply(v);
          }
        };
      }
    });
  });

  /**
   * 表格横向滚动包裹层（nodeView 方案）：
   * 必须经 $view 宏注册 —— 若直接写进 editorViewOptionsCtx.nodeViews，
   * 会在 view 构造时被展开的 options 整体覆盖，导致其它 $view 注册的
   * nodeViews（如数学公式）全部失效（行内/块级公式在编辑器中不可见）。
   */
  const tableScrollView = $view(tableSchema.node, () => {
    return (_node: ProseNode, _view: EditorView, _getPos: () => number | undefined): NodeView => {
      const wrapper = document.createElement('div');
      wrapper.className = 'table-scroll-wrapper';
      const table = document.createElement('table');
      const tbody = document.createElement('tbody');
      table.appendChild(tbody);
      wrapper.appendChild(table);
      return {
        dom: wrapper,
        contentDOM: tbody,
        update: (n: ProseNode) => n.type.name === 'table'
      };
    };
  });

  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, options.root);
      ctx.set(defaultValueCtx, options.initialMarkdown);

      ctx.update(editorViewOptionsCtx, (prev) => ({
        ...prev,
        attributes: {
          ...prev.attributes,
          spellcheck: 'false',
          class: 'typewren-prosemirror'
        },
        handlePaste: (_view, event) => {
          if (options.onPaste) return options.onPaste(event);
          return false;
        }
      }));

      configureCodeHighlight(ctx);

      // Fix strikethrough: single ~ parsed as strikethrough + ~~ escaped as \~\~
      applyStrikethroughFixes(ctx);

      const listenerManager = ctx.get(listenerCtx);
      listenerManager.markdownUpdated((_ctx, markdown) => {
        options.onMarkdownUpdated(markdown);
      });
    })
    .use(commonmark)
    .use(gfm)
    .use(highlight)
    .use(history)
    .use(listener)
    .use(trailing)
    .use(cursor)
    .use(remarkMathPlugin)
    .use(mathBlockSchema)
    .use(mathInlineSchema)
    .use(mathBlockView)
    .use(mathInlineView)
    .use(blockMathFullInputRule)
    .use(blockMathEmptyInputRule)
    .use(inlineMathInputRule)
    .use(tableTools)
    .use(taskListToggle)
    .use(tableScrollView)
    .use(viewEvents)
    .use(emptyDocPlaceholder)
    .create();

  function view(): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
  }

  return {
    editor,
    view,
    focus: () => view().focus()
  };
}
