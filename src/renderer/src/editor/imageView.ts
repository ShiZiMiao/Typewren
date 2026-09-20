import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { NodeView } from '@milkdown/kit/prose/view';
import { imageSchema } from '@milkdown/kit/preset/commonmark';
import { $view } from '@milkdown/kit/utils';

import { resolveImageSrc } from '../../../shared/imageUrl';

/* ============================================================
 * 图片节点视图：解决"粘贴的图片显示不出来"
 * Markdown 里图片引用保持相对路径（./assets/xx.png），渲染层页面
 * 基址却是应用目录（dev 为 localhost、打包为 out/renderer），相对 src
 * 永远解不到文档目录。这里只改 DOM <img> 的 src（解析为
 * typewren-img://local/… 交给主进程协议读盘），文档内容/序列化不动。
 * ============================================================ */

/** 文档目录提供器（main.ts 接线：文件服务里取当前文档绝对路径 → dirname） */
let docDirProvider: () => string | null = () => null;

export function setImageDocDirProvider(provider: () => string | null): void {
  docDirProvider = provider;
}

const reapplyFns = new Set<() => void>();

/** 文档目录变化（打开/另存为）后重新解析所有图片引用 */
export function refreshAllImageSrcs(): void {
  for (const fn of [...reapplyFns]) fn();
}

/**
 * 自定义 image 节点视图（$view 宏注册，注册表见 createEditor）：
 * 每次渲染把 attrs.src 解析成可加载 URL 填入 <img>；attrs 变化时
 * update 同步重写。文档内容仍持有原始相对引用。
 */
export const imageSrcView = $view(imageSchema.node, () => {
  return (node: ProseNode): NodeView => {
    const img = document.createElement('img');
    let current = node;

    const apply = (n: ProseNode): void => {
      const src = String(n.attrs.src ?? '');
      img.src = resolveImageSrc(src, docDirProvider());
      img.alt = String(n.attrs.alt ?? '');
      img.title = String(n.attrs.title ?? '');
    };
    const refresh = (): void => apply(current);

    apply(current);
    reapplyFns.add(refresh);

    return {
      dom: img,
      update: (n) => {
        current = n;
        apply(n);
        // 视图侧已同步 DOM，PM 不再按 attrs 重绘（避免 src 被写回相对路径）
        return true;
      },
      destroy: () => {
        reapplyFns.delete(refresh);
      }
    };
  };
});
