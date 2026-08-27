import { highlight, highlightPluginConfig } from '@milkdown/plugin-highlight'
import type { Ctx } from '@milkdown/kit/ctx'
import { createLowlight, common } from 'lowlight'
import { createParser } from 'prosemirror-highlight/lowlight'

/**
 * 代码块语法高亮：
 * lowlight（highlight.js 的 ESM 封装）→ prosemirror-highlight → milkdown 官方 highlight 插件
 * 预载 common 语言集（js/ts/python/java/c/cpp/go/rust/sql/yaml/json/bash/markdown 等 37 种）
 */
const lowlight = createLowlight(common)
const parser = createParser(lowlight)

export function configureCodeHighlight(ctx: Ctx): void {
  ctx.set(highlightPluginConfig.key, {
    parser,
    nodeTypes: ['code_block']
  })
}

export { highlight }
