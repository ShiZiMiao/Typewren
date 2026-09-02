import { test, expect } from '@playwright/test'
import {
  isMarkdownPath,
  isImagePath,
  isImageFile,
  isFileContentPayload,
  MARKDOWN_EXTENSIONS,
  IMAGE_EXTENSIONS
} from '../src/shared/ipc'
import { TITLEBAR_PALETTE } from '../src/shared/titlebar'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CSS_SOURCE = readFileSync(
  join(__dirname, '../src/renderer/src/styles/variables.css'),
  'utf-8'
)

/** 从 variables.css 取某主题下的变量值（防止与 TITLEBAR_PALETTE 漂移） */
function cssVar(theme: 'light' | 'dark', name: string): string {
  const [lightPart, darkPart] = CSS_SOURCE.split(":root[data-theme='dark']")
  const section = theme === 'dark' ? darkPart ?? CSS_SOURCE : lightPart ?? CSS_SOURCE
  const match = section.match(new RegExp(`${name}:\\s*([^;]+);`))
  if (!match) throw new Error(`CSS 变量 ${name}(${theme}) 未找到`)
  return match[1].trim()
}

/* ============================================================
 * L1 纯函数单测：直接 import 源码（Playwright 自带 TS 转译）
 * ============================================================ */

test.describe('shared/ipc 纯函数', () => {
  test('MARKDOWN_EXTENSIONS 常量', () => {
    expect(MARKDOWN_EXTENSIONS).toContain('.md')
    expect(MARKDOWN_EXTENSIONS).toContain('.markdown')
    expect(MARKDOWN_EXTENSIONS).toContain('.mdown')
  })

  test('isMarkdownPath 判断', () => {
    expect(isMarkdownPath('a.md')).toBe(true)
    expect(isMarkdownPath('a.markdown')).toBe(true)
    expect(isMarkdownPath('a.mdown')).toBe(true)
    expect(isMarkdownPath('A.MD')).toBe(true)
    expect(isMarkdownPath('dir/sub/a.MARKDOWN')).toBe(true)
    expect(isMarkdownPath('a.txt')).toBe(false)
    expect(isMarkdownPath('archive.tar.md')).toBe(true)
    expect(isMarkdownPath('README')).toBe(false)
    expect(isMarkdownPath('noext.')).toBe(false)
  })

  test('isImagePath 判断', () => {
    expect(isImagePath('pic.png')).toBe(true)
    expect(isImagePath('pic.jpg')).toBe(true)
    expect(isImagePath('pic.jpeg')).toBe(true)
    expect(isImagePath('pic.gif')).toBe(true)
    expect(isImagePath('pic.webp')).toBe(true)
    expect(isImagePath('pic.svg')).toBe(true)
    expect(isImagePath('pic.tiff')).toBe(true)
    expect(isImagePath('PIC.PNG')).toBe(true)
    expect(isImagePath('pic.exe')).toBe(false)
    expect(isImagePath('pic')).toBe(false)
  })

  test('isImageFile 判断（type 优先，扩展名兜底）', () => {
    expect(isImageFile({ type: 'image/png', name: 'a.bin' })).toBe(true)
    expect(isImageFile({ type: '', name: 'a.png' })).toBe(true)
    expect(isImageFile({ type: 'text/plain', name: 'a.png' })).toBe(true)
    expect(isImageFile({ type: 'application/octet-stream', name: 'evil.exe' })).toBe(false)
    expect(isImageFile({ type: '', name: 'evi.txt' })).toBe(false)
  })

  test('isFileContentPayload 类型守卫', () => {
    expect(isFileContentPayload({ path: '/x.md', content: 'abc' })).toBe(true)
    expect(isFileContentPayload({ path: '', content: '' })).toBe(true)
    expect(isFileContentPayload({ path: '/x.md' })).toBe(false)
    expect(isFileContentPayload({ path: 3, content: 'abc' })).toBe(false)
    expect(isFileContentPayload(null)).toBe(false)
    expect(isFileContentPayload('str')).toBe(false)
    expect(isFileContentPayload(undefined)).toBe(false)
  })
})

test.describe('标题栏配色常量与 CSS 变量同步', () => {
  test('亮色调色板与 --bg-soft / --text-muted 一致', () => {
    expect(TITLEBAR_PALETTE.light.color).toBe(cssVar('light', '--bg-soft'))
    expect(TITLEBAR_PALETTE.light.symbolColor).toBe(cssVar('light', '--text-muted'))
  })

  test('暗色调色板与 --bg-soft / --text-muted 一致', () => {
    expect(TITLEBAR_PALETTE.dark.color).toBe(cssVar('dark', '--bg-soft'))
    expect(TITLEBAR_PALETTE.dark.symbolColor).toBe(cssVar('dark', '--text-muted'))
  })
})