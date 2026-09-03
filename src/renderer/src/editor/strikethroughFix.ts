import { parserCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { remarkGFMPlugin } from '@milkdown/kit/preset/gfm';
import type { Ctx } from '@milkdown/kit/ctx';

/**
 * 序列化修复：
 *
 * 1. 解析器（remark-gfm）：默认 singleTilde=true，把单个 ~ 也解析为删除线
 *   （如 H1~H4 被渲染成 ~~H1~H4~~）。修复：{ singleTilde: false }。
 *
 * 2. 序列化器（删除线）：mdast-util-gfm-strikethrough 的 handleDelete 在调用
 *   state.containerPhrasing 时传入 before: '~~'（完整分隔符），safe() 会把
 *   ~~ 中的两个 ~ 都当上下文字符转义为 \~\~。修复：覆盖 delete handler，
 *   before/after 只用 '~'。
 *
 * 3. 序列化器（零多余转义）：mdast 的默认 unsafe 规则会把语段内所有 _、*、~、
 *   `、[、< 等标点全部转义（它们没有前后相邻约束），导致源码模式显示
 *   foo\_bar、\~/.bashrc 这类“原文件没有的转义”。
 *   修复：覆盖 text handler——先去转义，再用编辑器同源解析器把候选文本
 *   解析回去，只有“重解析仍是同一个文本节点”时才原样输出；否则（字面
 *   强调 _a_、行首 # 等会被误读为语法的文本）才退回 safe() 的转义结果。
 *   escapeTracking.relaxed 供 getMarkdown 决定是否做整篇回读校验。
 */

/** 序列化模式开关：strict 走默认 safe()（整篇兜底用），relaxed 尽力去转义 */
export const escapeTracking = {
  strict: false,
  relaxed: false
};

/**
 * 用解析器把文本解析为单个文本节点时返回其内容，否则返回 null。
 * 兼容两种取值形状：ProseMirror Node（编辑器解析器 child()/childCount）
 * 与 mdast（测试 mock children[]）。
 */
function parseAsSingleText(
  getParser: () => ((text: string) => unknown) | undefined,
  text: string
): string | null {
  try {
    const doc = getParser()?.(text);
    if (!doc) return null;

    // ProseMirror Node：childCount + child(i)，type 是 { name }
    const pm = doc as {
      childCount?: number;
      child?: (index: number) => unknown;
    };
    if (typeof pm.childCount === 'number' && typeof pm.child === 'function') {
      if (pm.childCount !== 1) return null;
      const para = pm.child(0) as {
        type?: { name?: string };
        childCount?: number;
        child?: (index: number) => unknown;
      } | null;
      if (!para || para.type?.name !== 'paragraph') return null;
      if (typeof para.childCount !== 'number' || typeof para.child !== 'function') {
        return null;
      }
      if (para.childCount !== 1) return null;
      const only = para.child(0) as { type?: { name?: string }; text?: unknown } | null;
      if (!only || only.type?.name !== 'text') return null;
      return typeof only.text === 'string' ? only.text : null;
    }

    // mdast：children[]，type 是字符串
    const md = doc as { children?: unknown[] };
    if (!Array.isArray(md.children) || md.children.length !== 1) return null;
    const para = md.children[0] as {
      type?: string;
      children?: unknown[];
    } | null;
    if (!para || para.type !== 'paragraph') return null;
    const kids = Array.isArray(para.children) ? para.children : [];
    if (kids.length !== 1) return null;
    const only = kids[0] as { type?: string; value?: unknown } | null;
    return only && only.type === 'text' && typeof only.value === 'string' ? only.value : null;
  } catch {
    return null;
  }
}

/**
 * 修复 GFM 删除线与序列化“零多余转义”（由 createEditor 装配时调用）。
 */
export function applyStrikethroughFixes(ctx: Ctx): void {
  // 修复 1：禁止单波浪线作为删除线语法
  ctx.update(remarkGFMPlugin.options.key, (prev) => ({
    ...prev,
    singleTilde: false
  }));

  // 序列化发生在编辑器就绪之后，parserCtx 必然可用（取一次即可）
  const getParser = () => ctx.get(parserCtx);

  // 修复 2 + 3：删除线转义与 text 零多余转义
  // 参数类型由 remarkStringifyOptionsCtx 的 handlers 签名推断（node: any 来自
  // mdast-util-to-markdown 自身类型，此处不引入额外 any）
  ctx.update(remarkStringifyOptionsCtx, (prev) => ({
    ...prev,
    handlers: {
      ...prev.handlers,
      delete: (node, _parent, state, info) => {
        const tracker = state.createTracker(info);
        // ConstructName 的成员由 mdast-util-gfm-strikethrough 的模块增强声明，
        // 该包未被本工程直接依赖时类型未注册，这里按调用方实际接受的联合取参
        const exit = state.enter('strikethrough' as Parameters<typeof state.enter>[0]);
        let value = tracker.move('~~');
        value += tracker.move(
          state.containerPhrasing(node, {
            ...tracker.current(),
            before: '~',
            after: '~'
          })
        );
        value += tracker.move('~~');
        exit();
        return value;
      },
      text: (node, _parent, state, info) => {
        const raw = String((node as { value?: unknown }).value ?? '');
        if (raw === '') return '';

        // 整篇兜底：严格模式直接走默认 safe()
        if (escapeTracking.strict) return state.safe(raw, info);

        const safeOut = state.safe(raw, info);
        // 没有转义时无需处理（最常见的路径）
        if (safeOut === raw) return raw;

        // 去掉全部转义后，若编辑器同源解析器仍解析为同一个文本节点 → 原样输出
        if (parseAsSingleText(getParser, raw) === raw) {
          escapeTracking.relaxed = true;
          return raw;
        }

        // 去掉转义会被误读为语法（字面强调 / 行首标题等）→ 保留安全转义
        return safeOut;
      }
    }
  }));
}
