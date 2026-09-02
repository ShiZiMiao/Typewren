import { test, expect } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, closeApp, type AppHandle } from './helpers'

/* ============================================================
 * 图片下载 / 剪贴板位图落盘（image:download / image:save-from-data）
 * 用本机临时 HTTP 服务模拟远程图片，覆盖安全边界。
 * ============================================================ */

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64')
/** 超过 25MB 上限的响应体 */
const BIG_BYTES = Buffer.alloc(26 * 1024 * 1024, 0x41)

let app: AppHandle
let server: Server
let baseUrl: string
let destDir: string

test.beforeAll(async () => {
  destDir = join(tmpdir(), 'typewren-img-download')
  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })

server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url === '/ok.png' || url === '/oa-without-ext') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG_BYTES)
      return
    }
    if (url === '/not-image') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello')
      return
    }
    if (url === '/missing') {
      res.writeHead(404)
      res.end('not found')
      return
    }
    if (url === '/big.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(BIG_BYTES)
      return
    }
    res.writeHead(404)
    res.end('nope')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`

  app = await launchApp()
})

test.afterAll(async () => {
  await closeApp(app)
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
})

interface SaveResult {
  ok: boolean
  savedPath?: string
  error?: string
}

function callDownload(url: string): Promise<SaveResult> {
  return app.window.evaluate(
    async ({ url, destDir }) => {
      return (window as unknown as { typewren: { downloadImage: (p: unknown) => Promise<SaveResult> } }).typewren
        .downloadImage({ url, destDir })
    },
    { url, destDir }
  )
}

test.describe('网络图片下载', () => {
  test('合法图片下载落到目标目录', async () => {
    const res = await callDownload(`${baseUrl}/ok.png`)
    expect(res.ok).toBe(true)
    const savedPath = res.savedPath!
    expect(existsSync(savedPath)).toBe(true)
    expect(readFileSync(savedPath).slice(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })

  test('无扩展名但 content-type 为图片可下载', async () => {
    const res = await callDownload(`${baseUrl}/oa-without-ext`)
    expect(res.ok).toBe(true)
  })

  test('HTTP 404 返回失败', async () => {
    const res = await callDownload(`${baseUrl}/missing`)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('404')
  })

  test('非图片 content-type 被拒绝', async () => {
    const res = await callDownload(`${baseUrl}/not-image`)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不是图片')
  })

  test('非 http/https 协议被拒绝', async () => {
    for (const url of ['file:///C:/tmp/x.png', 'ftp://example.com/x.png']) {
      const res = await callDownload(url)
      expect(res.ok).toBe(false)
      expect(res.error).toContain('仅支持 http/https')
    }
  })

  test('超过 25MB 的图片被拒绝', async () => {
    const res = await callDownload(`${baseUrl}/big.png`)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('25MB')
  })
})

test.describe('剪贴板位图（base64）落盘', () => {
  test('合法 PNG 落盘', async () => {
    const res = await app.window.evaluate(
      async ({ base64, destDir }) => {
        return (window as unknown as { typewren: { saveImageFromData: (p: unknown) => Promise<SaveResult> } })
          .typewren.saveImageFromData({ base64, mime: 'image/png', destDir })
      },
      { base64: PNG_BASE64, destDir }
    )
    expect(res.ok).toBe(true)
    const savedPath = res.savedPath!
    expect(existsSync(savedPath)).toBe(true)
    expect(readFileSync(savedPath).slice(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })

  test('空数据被拒绝', async () => {
    const res = await app.window.evaluate(
      async ({ dest }) => {
        return (window as unknown as { typewren: { saveImageFromData: (p: unknown) => Promise<SaveResult> } })
          .typewren.saveImageFromData({ base64: '', mime: 'image/png', destDir: dest })
      },
      { dest: destDir }
    )
    expect(res.ok).toBe(false)
  })

  test('超过 25MB 的 base64 被拒绝', async () => {
    const big64 = Buffer.alloc(26 * 1024 * 1024, 0x42).toString('base64')
    const res = await app.window.evaluate(
      async ({ base64, destDir }) => {
        return (window as unknown as { typewren: { saveImageFromData: (p: unknown) => Promise<SaveResult> } })
          .typewren.saveImageFromData({ base64, mime: 'image/bmp', destDir })
      },
      { base64: big64, destDir }
    )
    expect(res.ok).toBe(false)
  })
})

test.describe('未保存文档图片落盘到用户数据区', () => {
  test('destDir 为 null 时写入 userData/images', async () => {
    const res = await app.window.evaluate(
      async ({ base64 }) => {
        return (window as unknown as { typewren: { saveImageFromData: (p: unknown) => Promise<SaveResult> } })
          .typewren.saveImageFromData({ base64, mime: 'image/png', destDir: null })
      },
      { base64: PNG_BASE64 }
    )
expect(res.ok).toBe(true)
    const savedPath = res.savedPath!
    expect(savedPath).toBeTruthy()
    expect(existsSync(savedPath)).toBe(true)
  })
})