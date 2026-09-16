import type { EditorView } from '@milkdown/kit/prose/view';
import { Plugin } from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';

/* ============================================================
 * Tab 键行为：渲染模式下插入制表符（\t 字符，Markdown 中保留）。
 * ProseMirror 默认 keymap 会把 Tab 用于"聚焦下一个元素"，
 * 编辑器内必须拦截；源码模式由 sourceMode.ts 的 keydown 处理
 * （那里此前插入两个空格，现统一改为制表符字符）。
 * ============================================================ */

export const tabKeyPlugin = $prose(() => {
  return new Plugin({
    props: {
      handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
        if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.metaKey) {
          return false;
        }
        event.preventDefault();
        const { state } = view;
        const node = state.schema.text('\t');
        if (!node) return false;
        view.dispatch(state.tr.replaceSelectionWith(node));
        return true;
      }
    }
  });
});
