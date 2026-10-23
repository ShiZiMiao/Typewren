import { htmlSchema } from '@milkdown/kit/preset/commonmark';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { NodeView } from '@milkdown/kit/prose/view';
import { $view } from '@milkdown/kit/utils';

import { sanitizeHtml } from './htmlSanitize';
import { resolveImageSrc } from '../../../shared/imageUrl';
import { getImageDocDirProvider } from './imageView';

/** html 块内 img 的本地引用解析（与 imageView 同一口径；无文档目录时原样透传） */
function resolveHtmlImgSrc(src: string): string {
  return resolveImageSrc(src, getImageDocDirProvider()());
}

/* ============================================================
 * Raw HTML 节点展示（<details>/<script>/<InteractiveQuiz> 等）
 * commonmark preset 把原始 HTML 解析为 `html` 原子节点，默认
 * toDOM 是行内 span 纯文本——多行 HTML 块以正文样式铺开，像
 * "代码块渲染坏了"。
 * 本模块只改编辑器视图（NodeView），净化逻辑统一走
 * editor/htmlSanitize.ts（白名单标签 + 属性剥离）：
 * - 普通 HTML 净化后真渲染（加粗、表格等直接呈现）；details
 *   折叠块与 InteractiveQuiz 卡片分别由 details.ts / quiz.ts
 *   的容器节点承接（此处不再负责）；
 * - script/style 按浏览器行为隐藏（VitePress 等站点构建期源码
 *   不渲染，内容经源码模式可见；执行即 XSS）；
 * - 未知标签（Vue 组件等）无法渲染，保留标签原文文本；
 * - 仅闭合标签（如孤立的 `</details>`）渲染为空，不留痕。
 * schema/序列化/导出不动（导出仍是 span 文本，零回归）。
 * ============================================================ */

class RawHtmlView implements NodeView {
  dom: HTMLElement;

  constructor(private node: ProseNode) {
    this.dom = document.createElement('span');
    this.dom.setAttribute('contenteditable', 'false');
    this.render(node.attrs.value as string);
  }

  /** 就地重建内容：PM 持有创建时的 dom 引用，update 里换新元素
   * 会让引用悬空（定位/删除错乱），只允许改内部内容 */
  private render(value: string): void {
    const result = sanitizeHtml(value, resolveHtmlImgSrc);
    this.dom.className =
      result.kind === 'empty'
        ? 'typewren-raw-html'
        : 'typewren-raw-html typewren-raw-html-rendered';
    this.dom.replaceChildren();
    if (result.kind === 'html') {
      this.dom.appendChild(result.fragment);
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

export const rawHtmlView = $view(htmlSchema.node, () => {
  return (node) => new RawHtmlView(node);
});
