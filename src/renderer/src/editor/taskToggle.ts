import { Plugin } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

/* ============================================================
 * 任务列表勾选切换：
 * gfm 预设将任务项渲染为 li[data-item-type=task]，无原生 input。
 * 此插件在勾选框热区（左侧 30px）拦截点击，翻转 checked 属性。
 * ============================================================ */

/** 勾选框热区宽度（与 CSS ::before 绘制的方框宽度对齐） */
const CHECKBOX_HOTZONE_PX = 30;

export const taskListToggle = $prose(() => {
  return new Plugin({
    props: {
      handleClick: (view: EditorView, _pos: number, event: MouseEvent): boolean => {
        const target = event.target as HTMLElement | null;
        const li = target?.closest?.('li[data-item-type="task"]') ?? null;
        if (!li) return false;

        // 仅命中左侧勾选框热区时切换，其余区域保持正常文本编辑
        const rect = li.getBoundingClientRect();
        if (event.clientX - rect.left > CHECKBOX_HOTZONE_PX) return false;

        const innerPos = view.posAtDOM(li, 0);
        // posAtDOM 取不到位置时返回 -1，直接忽略
        if (innerPos < 0) return false;
        const $pos = view.state.doc.resolve(innerPos);

        let depth = $pos.depth;
        while (depth > 0 && $pos.node(depth).type.name !== 'list_item') depth--;
        if (depth === 0) return false;

        const nodePos = $pos.before(depth);
        const node = view.state.doc.nodeAt(nodePos);
        if (!node || node.attrs.checked == null) return false;

        view.dispatch(
          view.state.tr.setNodeMarkup(nodePos, undefined, {
            ...node.attrs,
            checked: !node.attrs.checked
          })
        );
        return true;
      }
    }
  });
});
