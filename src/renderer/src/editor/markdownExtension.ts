import { $remark } from '@milkdown/kit/utils';

/* ============================================================
 * Milkdown 插件共享设施
 * - markdownExtensionPlugin：把 mdast-util-to-markdown 扩展
 *   （自定义节点类型的序列化 handler）挂到统一 processor 上。
 *   关键（两处重复踩过的坑，勿改）：必须在**插件主体执行时**
 *   写入 data('toMarkdownExtensions')——unified 的 stringify
 *   只调 compiler 不跑 transformer，写进 transformer 里
 *   handler 永远不会挂载（与 remark-frontmatter 同一机制）。
 * ============================================================ */

/**
 * 生成注册 mdast 序列化扩展的 $remark 插件。
 * @param id 插件标识（唯一）
 * @param extension mdast-util-to-markdown 扩展对象（{ handlers, ... }）
 */
export function markdownExtensionPlugin(
  id: string,
  extension: { handlers: Record<string, (...args: never[]) => string> }
): ReturnType<typeof $remark> {
  return $remark(id, () => {
    return function registerMarkdownExtension(this: {
      data: (key: string, value?: unknown) => unknown;
    }) {
      const existing = (this.data('toMarkdownExtensions') as unknown[] | undefined) ?? [];
      this.data('toMarkdownExtensions', [...existing, extension]);
      return () => {};
    };
  });
}
