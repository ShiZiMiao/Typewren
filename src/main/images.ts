import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron';
import { constants as fsConstants, promises as fsp } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

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
import { isTestMode } from './runMode';

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

/**
 * URL 路径段扩展名（小写带点）；无扩展名或非图片扩展名返回 null。
 * 坑：旧实现无命中返回 ''，`??` 兜底链不认空串（只认 null/undefined）→
 * 文件以无扩展名落盘，typewren-img 协议按 isImagePath 拒载（403），图显示不出。
 */
export function extFromUrlPath(pathname: string): string | null {
  const dot = pathname.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = pathname.slice(dot).toLowerCase();
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext) ? ext : null;
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
  // ICO：00 00 01 00（reserved + type=1）；TIFF：'II*\0'（小端）/'MM\0*'（大端）。
  // 嗅探口径与 IMAGE_EXTENSIONS 对齐——嗅探不认识的格式在准入处被拒（见下），
  // 不补这两类会导致 .ico/.tif 插不进来
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x00 &&
    buffer[1] === 0x00 &&
    buffer[2] === 0x01 &&
    buffer[3] === 0x00
  ) {
    return '.ico';
  }
  if (buffer.length >= 4) {
    const head4 = buffer.slice(0, 4).toString('latin1');
    if (head4 === 'II*\u0000' || head4 === 'MM\u0000*') {
      return head4.startsWith('II') ? '.tif' : '.tiff';
    }
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

/** 把字节写入目标目录（唯一命名），返回绝对路径。
 *  同一秒内时间戳相同、4 位随机数也同分（并发粘贴/批量插入）时会撞名——
 *  用 flag 'wx' 独占创建：EEXIST 说明撞了已有图片，重新出名重试，
 *  绝不覆盖（旧实现同名直接覆写，可能毁掉文档里已引用的图片）。 */
async function writeImageBytes(
  docPath: string | null,
  buffer: Buffer,
  ext: string
): Promise<string> {
  const dir = await resolveDestDir(docPath);
  for (let attempt = 0; attempt < 5; attempt++) {
    const savedPath = join(dir, uniqueImageName(ext));
    try {
      await fsp.writeFile(savedPath, buffer, { flag: 'wx' });
      return savedPath;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
    }
  }
  throw new Error('图片命名冲突重试超限');
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

/**
 * SSRF 基础收紧：图片下载拒绝环回 / 私有网段 / 本机名（渲染层被攻破后拿
 * image:download 探测内网、打到本机管理接口）。只做**字面**主机名判定
 * （解析 DNS 后再判需要请求层拦截，此处不展开；redirect 也只看最终 URL）：
 * 环回 127.* / ::1、私有 10.* / 192.168.* / 172.16-31.*、链路本地 169.254.*、
 * 0.*（本网络）、localhost / *.localhost / *.local。
 * 注：--test 下放行（imageDownload.spec 的模拟图片服务就跑在 127.0.0.1，
 * 本地测试无公网回环替身），判定纯函数本身有单测兜底。
 */
export function isBlockedFetchHost(hostname: string): boolean {
  // IPv6 字面量去方括号（URL.hostname 对 IPv6 保留 []）
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const a = Number(ipv4[1]);
  const b = Number(ipv4[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
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
        // 先 stat 预检大小再读盘：整读进内存才查上限，25GB 的"图片"会先把内存吃爆
        const stat = await fsp.stat(payload.srcPath);
        if (!stat.isFile()) return failResult('不是普通文件');
        if (stat.size > MAX_IMAGE_BYTES) {
          return failResult('图片超过 25MB 限制');
        }
        const buffer = await fsp.readFile(payload.srcPath);
        // 头部嗅探为准，嗅不出来直接拒：旧实现回退用原扩展名放行，
        // 任意字节改个 .png 后缀就能落盘（与"准入校验"的注释承诺不符）
        const ext = sniffImageExt(buffer);
        if (!ext) return failResult('不是有效图片');
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
        // 解码前按 base64 长度预检：Buffer.from 会先把整串解进内存（DoS 面）。
        // 上限取 ≤MAX_IMAGE_BYTES 字节所能产出的最长 base64（ceil(n/3)*4，含 padding），
        // 比裸 n*4/3 略宽几个字符——边界值（恰好 25MB 的图）不能被误杀
        if (payload.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
          return failResult('图片数据无效或超过 25MB 限制');
        }
        const buffer = Buffer.from(payload.base64, 'base64');
        if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
          return failResult('图片数据无效或超过 25MB 限制');
        }
        // 嗅探为准（mime 只是渲染层自报，不可信），嗅不出直接拒
        const ext = sniffImageExt(buffer);
        if (!ext) return failResult('不是有效图片');
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
        // SSRF 基础收紧：环回/私有字面 IP 与本机名一律拒（--test 放行，
        // e2e 的 mock 图片服务就在 127.0.0.1；纯函数有单测）
        if (!isTestMode() && isBlockedFetchHost(url.hostname)) {
          return failResult('不支持本地/内网图片地址');
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
        // 超限后 break 正常收尾（不要在此 abort：流取消异常会被误报为超时）。
        // 用 getReader 逐块读而非 for-await：web/undici 两套 ReadableStream 类型
        // 只有一套带 Symbol.asyncIterator（tsconfig.test 的 DOM lib 下 for-await 编译报错）
        const chunks: Buffer[] = [];
        let received = 0;
        let oversized = false;
        const body = response.body;
        if (body) {
          const reader = body.getReader();
          for (;;) {
            const result = await reader.read();
            if (result.done) break;
            const chunk = Buffer.from(result.value);
            received += chunk.length;
            if (received > MAX_IMAGE_BYTES) {
              oversized = true;
              // 主动取消剩余流（少收一点是一点）；取消失败不影响结果
              await reader.cancel().catch(() => {});
              break;
            }
            chunks.push(chunk);
          }
        }
        if (oversized) return failResult('图片超过 25MB 限制');
        const buffer = Buffer.concat(chunks);
        if (buffer.length === 0) return failResult('下载内容为空');

        // 扩展名兜底链：嗅探 → URL 路径段 → Content-Type。
        // extFromUrlPath 无命中必须返回 null（空串会让 ?? 链断掉，
        // 文件以无扩展名落盘后 typewren-img 协议 403 显示不出）
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
