import type { EditorView } from '@milkdown/kit/prose/view';
import { Plugin } from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';

/* ============================================================
 * Ctrl/Cmd+点击超链接跳转（Typora 式，见 AGENTS 决策 #24）：
 * 编辑器内 <a> 的修饰键点击 → 交主进程裁决打开（md 链接新窗口、
 * http(s)/mailto 交系统浏览器；死链/未知协议静默忽略）。
 * 挂 view.dom **捕获阶段**：先于 PM 内部 handler 与浏览器默认行为
 * （不拦的话浏览器会按页面基址尝试导航，Ctrl+点击在浏览器语义下
 * 是 window.open 新窗——都偏离期望），preventDefault 一并压住。
 * 普通点击（无修饰键）不拦截：光标落位/选中照常，语义无变化。
 * ============================================================ */

export const linkOpenPlugin = $prose(() => {
  return new Plugin({
    view(view: EditorView) {
      const onClick = (event: MouseEvent): void => {
        if (event.button !== 0) return;
        // Cmd（macOS）与 Ctrl 同语义——与 Typora/系统惯例一致
        if (!(event.ctrlKey || event.metaKey)) return;
        const anchor = event.target instanceof Element ? event.target.closest('a') : null;
        if (!anchor) return;
        const href = anchor.getAttribute('href');
        if (!href) return;
        event.preventDefault();
        event.stopPropagation();
        window.typewren.openLink(href);
      };
      view.dom.addEventListener('click', onClick, true);
      return {
        destroy() {
          view.dom.removeEventListener('click', onClick, true);
        }
      };
    }
  });
});
