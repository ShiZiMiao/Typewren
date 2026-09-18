import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron';
import { constants as fsConstants, promises as fsp } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { fromLocalImageUrl, IMAGE_URL_SCHEME } from '../shared/imageUrl';
import type {
  AssetsCopyPayload,
  AssetsCopyResult,
  ImageDownloadPayload,
  ImageSaveFromDataPayload,
  ImageSaveFromPathPayload,
  ImageSaveResult
} from '../shared/ipc';
import {
  IMAGE_EXTENSIONS,
  isAssetsCopyPayload,
  isImageDownloadPayload,
  isImagePath,
  isImageSaveFromDataPayload,
  isImageSaveFromPathPayload
} from '../shared/ipc';

/* ============================================================
 * 图片粘贴 / 拖拽落盘（主进程侧）
 * 渲染层只传来源（文件路径 / 剪贴板位图 base64 / 网络 URL）与文档路径，
 * 落盘目录由主进程统一推导——渲染层无法指定任意目录（越权写防护）。
 * 这里统一：唯一命名 → 写/复制到目标目录 → 返回绝对路径。
 * ============================================================ */

/** 单张图片大小上限（超出视为异常，避免误粘大文件卡死） */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** 网络下载超时（慢源/僵死连接不拖死粘贴流程） */
const DOWNLOAD_TIMEOUT_MS = 15_000;

/** mime → 扩展名（未知时默认 .png） */
function extFromMime(mime: string): string {
  const table: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/bmp': '.bmp'
  };
  return table[mime.split(';')[0].trim().toLowerCase()] ?? '.png';
}

/** URL 路径段扩展名（小写带点）；非图片扩展名返回空串 */
function extFromUrlPath(pathname: string): string {
  const dot = pathname.lastIndexOf('.');
  if (dot < 0) return '';
  const ext = pathname.slice(dot).toLowerCase();
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext) ? ext : '';
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
    return '.png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return '.jpg';
  }
  if (buffer.length >= 3 && buffer[0] === 0x47 && buffer[1] === 0x49) {
    return '.gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.slice(0, 4).toString('latin1') === 'RIFF' &&
    buffer.slice(8, 12).toString('latin1') === 'WEBP'
  ) {
    return '.webp';
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return '.bmp';
  }
  const head = buffer.slice(0, 1024).toString('utf8');
  if (head.includes('<svg')) return '.svg';
  return null;
}

/** 生成不冲突的图片文件名：image-20260901-103000-1234.png */
function uniqueImageName(ext: string): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return `image-${stamp}-${rand}${ext}`;
}

/**
 * 落盘目录：文档已有绝对路径 → 同目录 assets/；未保存文档（docPath=null）
 * → 用户数据区默认目录。目录由主进程推导，渲染层无法指定任意位置。
 */
async function resolveDestDir(docPath: string | null): Promise<string> {
  const dir =
    docPath && docPath.length > 0
      ? join(dirname(docPath), 'assets')
      : join(app.getPath('userData'), 'images');
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** 把字节写入目标目录（唯一命名），返回绝对路径 */
async function writeImageBytes(
  docPath: string | null,
  buffer: Buffer,
  ext: string
): Promise<string> {
  const dir = await resolveDestDir(docPath);
  const savedPath = join(dir, uniqueImageName(ext));
  await fsp.writeFile(savedPath, buffer);
  return savedPath;
}

/** 校验 docPath 字段（可选：非 null 时必须是绝对路径，拒绝相对路径越权） */
function validDocPath(docPath: string | null): boolean {
  return docPath === null || isAbsolute(docPath);
}

/** 失败结果（不弹框，由渲染层决定是否提示） */
function failResult(error: unknown): ImageSaveResult {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  };
}

/** 扩展名 → Content-Type（协议响应头） */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff'
};

/**
 * 编辑器内图片加载协议：
 * 渲染层把本地图片引用（相对 ./assets/… 或绝对路径）解析为
 * `typewren-img://local/<encodeURIComponent(绝对路径)>` 后由浏览器发起加载，
 * 这里解码读盘返回。页面基址是应用目录（dev 为 localhost、打包为 out/renderer），
 * 相对 src 永远解不到文档目录——协议是"按文档目录解析"的唯一落点。
 * 校验口径与落盘一致：绝对路径 + 受支持图片扩展名（防任意文件被读出）。
 */
export function registerImageProtocol(): void {
  protocol.handle(IMAGE_URL_SCHEME, async (request) => {
    const filePath = fromLocalImageUrl(request.url);
    if (!filePath || !isAbsolute(filePath)) {
      return new Response('Bad Request', { status: 400 });
    }
    const absolute = resolve(filePath);
    if (!isImagePath(absolute)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const data = await fsp.readFile(absolute);
      const dot = absolute.lastIndexOf('.');
      const ext = dot >= 0 ? absolute.slice(dot).toLowerCase() : '';
      return new Response(new Uint8Array(data), {
        headers: { 'content-type': IMAGE_MIME[ext] ?? 'application/octet-stream' }
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}

export function registerImageHandlers(): void {
  // ---------- 「插入图片」原生文件选择框（多选；仅受支持图片扩展名） ----------
  ipcMain.handle('dialog:open-image', async (event): Promise<string[]> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return [];
    const extensions = (IMAGE_EXTENSIONS as readonly string[]).map((ext) => ext.slice(1));
    const result = await dialog.showOpenDialog(win, {
      title: '选择图片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions }]
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    return result.filePaths;
  });

  // ---------- 本地文件 → assets 复制 ----------
  ipcMain.handle(
    'image:save-from-path',
    async (_event, payload: ImageSaveFromPathPayload): Promise<ImageSaveResult> => {
      try {
        if (!isImageSaveFromPathPayload(payload) || !validDocPath(payload.docPath)) {
          return failResult('无效的请求参数');
        }
        // 源路径只接受受支持的图片扩展名，防止任意文件流入 assets
        if (!isImagePath(payload.srcPath)) {
          return failResult('不支持的图片格式');
        }
        const buffer = await fsp.readFile(payload.srcPath);
        if (buffer.length > MAX_IMAGE_BYTES) {
          return failResult('图片超过 25MB 限制');
        }
        const originalExt = `.${basename(payload.srcPath).split('.').pop() ?? ''}`.toLowerCase();
        const ext = sniffImageExt(buffer) ?? originalExt;
        const savedPath = await writeImageBytes(payload.docPath, buffer, ext);
        return { ok: true, savedPath };
      } catch (error) {
        return failResult(error);
      }
    }
  );

  // ---------- 剪贴板位图（base64）落盘 ----------
  ipcMain.handle(
    'image:save-from-data',
    async (_event, payload: ImageSaveFromDataPayload): Promise<ImageSaveResult> => {
      try {
        if (!isImageSaveFromDataPayload(payload) || !validDocPath(payload.docPath)) {
          return failResult('无效的请求参数');
        }
        if (payload.base64.length === 0) {
          return failResult('空图片数据');
        }
        const buffer = Buffer.from(payload.base64, 'base64');
        if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
          return failResult('图片数据无效或超过 25MB 限制');
        }
        const ext = sniffImageExt(buffer) ?? extFromMime(payload.mime);
        const savedPath = await writeImageBytes(payload.docPath, buffer, ext);
        return { ok: true, savedPath };
      } catch (error) {
        return failResult(error);
      }
    }
  );

  // ---------- 网络图片下载本地化 ----------
  ipcMain.handle(
    'image:download',
    async (_event, payload: ImageDownloadPayload): Promise<ImageSaveResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
      try {
        if (!isImageDownloadPayload(payload) || !validDocPath(payload.docPath)) {
          return failResult('无效的请求参数');
        }
        const url = new URL(payload.url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          return failResult('仅支持 http/https 图片地址');
        }
        const response = await fetch(url, {
          redirect: 'follow',
          signal: controller.signal
        });
        if (!response.ok) return failResult(`下载失败：HTTP ${response.status}`);
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.startsWith('image/')) {
          return failResult(`目标不是图片（${contentType || '未知类型'}）`);
        }
        // Content-Length 预检（服务器给了头就不用等 body 全下来）
        const declared = Number(response.headers.get('content-length') ?? 0);
        if (declared > MAX_IMAGE_BYTES) {
          return failResult('图片超过 25MB 限制');
        }

        // 流式接收 + 边收边限上限，避免整块进内存后再检查。
        // 超限后 break 正常收尾（不要在此 abort：流取消异常会被误报为超时）
        const chunks: Buffer[] = [];
        let received = 0;
        let oversized = false;
        if (response.body) {
          for await (const chunk of response.body) {
            received += chunk.length;
            if (received > MAX_IMAGE_BYTES) {
              oversized = true;
              break;
            }
            chunks.push(Buffer.from(chunk));
          }
        }
        if (oversized) return failResult('图片超过 25MB 限制');
        const buffer = Buffer.concat(chunks);
        if (buffer.length === 0) return failResult('下载内容为空');

        const ext =
          sniffImageExt(buffer) ?? extFromUrlPath(url.pathname) ?? extFromMime(contentType);
        const savedPath = await writeImageBytes(payload.docPath, buffer, ext);
        return { ok: true, savedPath };
      } catch (error) {
        const message = controller.signal.aborted
          ? '下载超时或已中止'
          : error instanceof Error
            ? error.message
            : String(error);
        return failResult(message);
      } finally {
        clearTimeout(timer);
      }
    }
  );

  // ---------- 另存为后的附件迁移：源文档同目录 assets/ → 新文档同目录 assets/ ----------
  ipcMain.handle(
    'assets:copy',
    async (_event, payload: AssetsCopyPayload): Promise<AssetsCopyResult> => {
      try {
        if (
          !isAssetsCopyPayload(payload) ||
          !isAbsolute(payload.fromDoc) ||
          !isAbsolute(payload.toDoc)
        ) {
          return { ok: false, error: '无效的请求参数' };
        }
        const srcDir = join(dirname(payload.fromDoc), 'assets');
        const destDir = join(dirname(payload.toDoc), 'assets');
        // 同一目录无需复制
        if (srcDir === destDir) return { ok: true, copied: 0 };
        let entries: string[];
        try {
          entries = await fsp.readdir(srcDir);
        } catch {
          // 源 assets 目录不存在（文档从未插入过本地图片）视为成功空操作
          return { ok: true, copied: 0 };
        }
        await fsp.mkdir(destDir, { recursive: true });
        let copied = 0;
        // 只复制受支持的图片，已存在的跳过（不覆盖新位置的同名文件）
        for (const name of entries.slice(0, 5000)) {
          if (!isImagePath(name)) continue;
          const dest = join(destDir, name);
          try {
            await fsp.copyFile(join(srcDir, name), dest, fsConstants.COPYFILE_EXCL);
            copied += 1;
          } catch {
            // 已存在或单个文件失败：跳过
          }
        }
        return { ok: true, copied };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );
}
