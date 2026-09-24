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

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
/** 历史 encodeURI 产物：`C:%5CUsers%5C…`（驱动器号 + 编码反斜杠） */
const WINDOWS_ESCAPED_ABSOLUTE = /^[A-Za-z]:%5C/i;
const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Markdown 引用 → 解析前的原始路径：撤销引用侧的百分号编码
 * （imagePasteService.encodeMarkdownPath 是编码端，两者必须成对演进）。
 * resolveImageSrc 不做解码——%xx 会以字面量进文件路径永远找不到文件
 * （encodeURI 的 %20 就曾让带空格的用户目录 404），故解码收口在调用侧。
 * 判定顺序与 shared/imageUrl.resolveImageSrc 一致：盘符绝对路径（含历史
 * %5C 形态）先于通用 scheme 判定——`C:/x` 的 `C:` 形似 scheme，把它当
 * URL 就不还原了；真 URL（http/data 等）里 %23 是文件名的 #，解码反而
 * 会被当 fragment，必须原样。非法转义（文件名里的裸 %）解码失败原样返回。
 */
export function decodeImageRef(src: string): string {
  if (!src) return src;
  const isLocalRef =
    WINDOWS_ABSOLUTE.test(src) ||
    WINDOWS_ESCAPED_ABSOLUTE.test(src) ||
    src.startsWith('/') ||
    !HAS_SCHEME.test(src);
  if (!isLocalRef) return src;
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
}

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
      // 空 src 不赋值：img.src='' 会向页面基址发一次必然 404 的请求（噪音）
      if (src) img.src = resolveImageSrc(decodeImageRef(src), docDirProvider());
      else img.removeAttribute('src');
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
