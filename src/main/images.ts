import { app, ipcMain } from 'electron'
import { promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'

import type {
  ImageDownloadPayload,
  ImageSaveFromDataPayload,
  ImageSaveFromPathPayload,
  ImageSaveResult
} from '../shared/ipc'
import { IMAGE_EXTENSIONS, isImagePath } from '../shared/ipc'

/* ============================================================
 * 图片粘贴 / 拖拽落盘（主进程侧）
 * 渲染层已判断图片来源（文件路径 / 剪贴板位图 base64 / 网络 URL），
 * 这里统一：唯一命名 → 写/复制到目标目录 → 返回绝对路径。
 * ============================================================ */

/** 单张图片大小上限（超出视为异常，避免误粘大文件卡死） */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

/** mime → 扩展名（未知时默认 .png） */
function extFromMime(mime: string): string {
  const table: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/bmp': '.bmp'
  }
  return table[mime.split(';')[0].trim().toLowerCase()] ?? '.png'
}

/** URL 路径段扩展名（小写带点）；非图片扩展名返回空串 */
function extFromUrlPath(pathname: string): string {
  const dot = pathname.lastIndexOf('.')
  if (dot < 0) return ''
  const ext = pathname.slice(dot).toLowerCase()
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext) ? ext : ''
}

/** 嗅探二进制头部推断图片扩展名；无法识别返回 null */
function sniffImageExt(buffer: Buffer): string | null {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return '.png'
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return '.jpg'
  }
  if (buffer.length >= 3 && buffer[0] === 0x47 && buffer[1] === 0x49) {
    return '.gif'
  }
  if (
    buffer.length >= 12 &&
    buffer.slice(0, 4).toString('latin1') === 'RIFF' &&
    buffer.slice(8, 12).toString('latin1') === 'WEBP'
  ) {
    return '.webp'
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return '.bmp'
  }
  const head = buffer.slice(0, 1024).toString('utf8')
  if (head.includes('<svg')) return '.svg'
  return null
}

/** 生成不冲突的图片文件名：image-20260901-103000-1234.png */
function uniqueImageName(ext: string): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const rand = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
  return `image-${stamp}-${rand}${ext}`
}

/**
 * 落盘目录：文档已有路径 → docPath/assets；未保存文档 → 用户数据区默认目录。
 * 确保目录存在。
 */
async function resolveDestDir(destDir: string | null): Promise<string> {
  const dir = destDir ?? join(app.getPath('userData'), 'images')
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

/** 把字节写入目标目录（唯一命名），返回绝对路径 */
async function writeImageBytes(
  destDir: string | null,
  buffer: Buffer,
  ext: string
): Promise<string> {
  const dir = await resolveDestDir(destDir)
  const savedPath = join(dir, uniqueImageName(ext))
  await fsp.writeFile(savedPath, buffer)
  return savedPath
}

/** 失败结果（不弹框，由渲染层决定是否提示） */
function failResult(error: unknown): ImageSaveResult {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }
}

export function registerImageHandlers(): void {
  // ---------- 本地文件 → assets 复制 ----------
  ipcMain.handle(
    'image:save-from-path',
    async (_event, payload: ImageSaveFromPathPayload): Promise<ImageSaveResult> => {
      try {
        // 源路径只接受受支持的图片扩展名，防止任意文件流入 assets
        if (typeof payload.srcPath !== 'string' || !isImagePath(payload.srcPath)) {
          return failResult('不支持的图片格式')
        }
        const buffer = await fsp.readFile(payload.srcPath)
        if (buffer.length > MAX_IMAGE_BYTES) {
          return failResult('图片超过 25MB 限制')
        }
        const originalExt =
          `.${basename(payload.srcPath).split('.').pop() ?? ''}`.toLowerCase()
        const ext = sniffImageExt(buffer) ?? originalExt
        const savedPath = await writeImageBytes(payload.destDir, buffer, ext)
        return { ok: true, savedPath }
      } catch (error) {
        return failResult(error)
      }
    }
  )

  // ---------- 剪贴板位图（base64）落盘 ----------
  ipcMain.handle(
    'image:save-from-data',
    async (_event, payload: ImageSaveFromDataPayload): Promise<ImageSaveResult> => {
      try {
        if (typeof payload.base64 !== 'string' || payload.base64.length === 0) {
          return failResult('空图片数据')
        }
        const buffer = Buffer.from(payload.base64, 'base64')
        if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
          return failResult('图片数据无效或超过 25MB 限制')
        }
        const ext = sniffImageExt(buffer) ?? extFromMime(payload.mime)
        const savedPath = await writeImageBytes(payload.destDir, buffer, ext)
        return { ok: true, savedPath }
      } catch (error) {
        return failResult(error)
      }
    }
  )

  // ---------- 网络图片下载本地化 ----------
  ipcMain.handle(
    'image:download',
    async (_event, payload: ImageDownloadPayload): Promise<ImageSaveResult> => {
      try {
        const url = new URL(payload.url)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          return failResult('仅支持 http/https 图片地址')
        }
        const response = await fetch(url, { redirect: 'follow' })
        if (!response.ok) return failResult(`下载失败：HTTP ${response.status}`)
        const contentType = response.headers.get('content-type') ?? ''
        if (!contentType.startsWith('image/')) {
          return failResult(`目标不是图片（${contentType || '未知类型'}）`)
        }

        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.length > MAX_IMAGE_BYTES) {
          return failResult('图片超过 25MB 限制')
        }
        const ext =
          sniffImageExt(buffer) ??
          extFromUrlPath(url.pathname) ??
          extFromMime(contentType)
        const savedPath = await writeImageBytes(payload.destDir, buffer, ext)
        return { ok: true, savedPath }
      } catch (error) {
        return failResult(error)
      }
    }
  )
}