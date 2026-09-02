import { test, expect, _electron as electron } from '@playwright/test'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let electronApp: Awaited<ReturnType<typeof electron.launch>>
let window: Awaited<ReturnType<typeof electronApp.firstWindow>>

const WORK_DIR = join(tmpdir(), 'typewren-img-test')
const DOC_PATH = join(WORK_DIR, 'doc.md')
/** 1x1 透明 PNG */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function ensureDoc(): void {
  if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true })
  if (!existsSync(DOC_PATH)) writeFileSync(DOC_PATH, '# 图片测试\n')
}

test.beforeAll(async () => {
  ensureDoc()
  electronApp = await electron.launch({
    args: ['--test', join(__dirname, '../out/main/index.js')]
  })
  window = await electronApp.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('.ProseMirror', { timeout: 10000 })
  await window.waitForTimeout(1000)
})

test.afterAll(async () => {
  await electronApp.close()
})

/** 打开带路径的文档，使图片 assets 目录落到文档同目录 */
test.beforeEach(async () => {
  ensureDoc()
  await electronApp.evaluate(({ BrowserWindow }, { path, content }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('cmd', 'open-file-path', {
      path,
      content
    })
  }, { path: DOC_PATH, content: readFileSync(DOC_PATH, 'utf-8') })
  await window.waitForSelector('.ProseMirror h1', { timeout: 5000 })
})

test.describe('图片粘贴/拖拽', () => {
  test('拖拽图片文件：保存 assets 并插入相对路径', async () => {
    const srcName = 'drag-image.png'
    // 合成带图片文件的 drop 事件（与真实拖拽同一入口 handleImageDrop/insertFiles）
    await window.locator('.ProseMirror').evaluate((el, base64) => {
const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'drop.png', { type: 'image/png' }))
      el.dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true })
      )
    }, PNG_BASE64)

    // 等插入的图片元素出现（保存+插入是异步链路）；
    // 测试环境图片相对路径无法加载，只断言 DOM 与落盘的产物
    const img = window.locator('.ProseMirror img[src^="./assets/"]')
    await expect(img).toHaveCount(1, { timeout: 10000 })

    const src = await img.getAttribute('src')
    expect(src).toMatch(/^\.\/assets\/image-\d{8}-\d{6}-\d{4}\.png$/)

    // 磁盘上存在该文件且为合法 PNG
    const savedPath = join(WORK_DIR, src!.replace(/^\.\//, ''))
    const buf = readFileSync(savedPath)
    expect(buf.slice(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })

  test('本地文件复制：saveImageFromPath 落盘 assets', async () => {
    const srcPng = join(WORK_DIR, 'src-image.png')
    if (!existsSync(srcPng)) {
      writeFileSync(srcPng, Buffer.from(PNG_BASE64, 'base64'))
    }

    const result = await window.evaluate(async ({ srcPath, destDir }) => {
      return window.typewren.saveImageFromPath({ srcPath, destDir })
    }, { srcPath: srcPng, destDir: join(WORK_DIR, 'assets') })

    expect(result.ok).toBe(true)
    const savedPath = (result as { savedPath: string }).savedPath
    expect(savedPath).toMatch(/image-\d{8}-\d{6}-\d{4}\.png$/)
    expect(existsSync(savedPath)).toBe(true)
    expect(readFileSync(savedPath).slice(0, 8).toString('hex')).toBe(
      '89504e470d0a1a0a'
    )
  })

  test('不支持的源扩展名被拒绝', async () => {
    const exePath = join(WORK_DIR, 'evil.txt')
    writeFileSync(exePath, 'not an image')
    const result = await window.evaluate(async ({ srcPath, destDir }) => {
      return window.typewren.saveImageFromPath({ srcPath, destDir })
    }, { srcPath: exePath, destDir: join(WORK_DIR, 'assets') })
    expect(result.ok).toBe(false)
  })
})