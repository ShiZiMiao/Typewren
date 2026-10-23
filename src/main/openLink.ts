import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { IMAGE_EXTENSIONS, isOpenablePath } from '../shared/ipc';

/* ============================================================
 * Ctrl/Cmd+点击超链接（file:open-link，Typora 式跳转）：
 * - 相对/绝对 md、txt 链接 → 编辑器新窗口打开（本窗口是"非空文档"
 *   才可能有链接，故就地打开分支永不需要，直接新窗口）；
 * - 图片 / pdf → 系统默认程序打开（白名单，防 .exe 等被 Ctrl+点击执行）；
 * - http/https/mailto → 系统浏览器 / 默认邮件客户端；
 * - 纯锚点 / 未知协议 / 死链 / 目录 → 静默忽略。
 * 渲染层只传 href，基准目录取主进程 docRegistry 登记的当前文档路径
 * （win:set-path 上报），不信任渲染层自报——与图片落盘同安全口径。
 * ============================================================ */

/** 驱动器号绝对路径（`C:/x` / `C:\x`）：形似 scheme，必须先于通用 scheme 判定 */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const HAS_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const EXTERNAL_SCHEMES = new Set(['http', 'https', 'mailto']);

export type LinkClassification =
  { kind: 'external'; url: string } | { kind: 'local'; path: string } | { kind: 'ignored' };

/** 链接 href 分类（纯函数；unit.spec 直测，issue/回归先来这层） */
export function classifyLinkHref(href: string): LinkClassification {
  const trimmed = href.trim();
  if (trimmed.length === 0) return { kind: 'ignored' };
  // 坑：`C:/x` 的驱动器号形似 scheme，盘符判定必须先于 HAS_SCHEME
  // （resolveImageSrc 同款踩坑，见 AGENTS 决策 #12）
  if (WINDOWS_ABSOLUTE.test(trimmed)) {
    return { kind: 'local', path: decodeLocalPath(trimmed) };
  }
  const scheme = HAS_SCHEME.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme) {
    // javascript:/data: 等未知协议一律忽略（与 isSafeLinkHref 同口径，防 XSS 面）
    return EXTERNAL_SCHEMES.has(scheme) ? { kind: 'external', url: trimmed } : { kind: 'ignored' };
  }
  // 本地相对路径：剥 fragment/query 要先于解码——原始 `#`/`?` 是锚点/查询串，
  // 文件名里的字面 `#`/`?` 必须写成 %23/%3F，先剥后解码才不会被二次截断
  const rawPath = trimmed.split(/[#?]/, 1)[0];
  if (rawPath.length === 0) return { kind: 'ignored' }; // 纯锚点（#top）
  return { kind: 'local', path: decodeLocalPath(rawPath) };
}

/** 撤销引用侧的百分号编码（`space%20doc.md` → `space doc.md`）；
 *  非法转义（文件名里的裸 % 等）解码抛错时原样透传 */
function decodeLocalPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export type OpenLinkOutcome =
  | { action: 'external'; url: string }
  | { action: 'open-window'; path: string }
  | { action: 'open-system'; path: string }
  | { action: 'none' };

/**
 * 系统默认程序打开的扩展名白名单：只放行"查看无害"类型（图片/pdf）。
 * 执行类（.exe/.bat/脚本）走系统打开 = 文档作者可借 Ctrl+点击执行任意程序，
 * 与窗口打开外链的防钓鱼口径不一致，白名单外一律忽略。
 */
const SYSTEM_OPEN_EXTENSIONS = [...IMAGE_EXTENSIONS, '.pdf'];

function systemOpenable(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return SYSTEM_OPEN_EXTENSIONS.includes(path.slice(dot).toLowerCase());
}

/**
 * 链接打开决策（plan 纯逻辑，io.ts 只按 outcome 执行副作用）。
 * docPath 为发送方窗口当前文档的绝对路径（docRegistry 登记值，非渲染层自报）。
 */
export function planLinkOpen(href: unknown, docPath: string | null): OpenLinkOutcome {
  if (typeof href !== 'string') return { action: 'none' };
  const cls = classifyLinkHref(href);
  if (cls.kind === 'ignored') return { action: 'none' };
  if (cls.kind === 'external') {
    try {
      const scheme = new URL(cls.url).protocol.toLowerCase();
      if (scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:') {
        return { action: 'external', url: cls.url };
      }
    } catch {
      // 非法 URL（缺协议等）一律忽略
    }
    return { action: 'none' };
  }
  // 本地路径：基准 = 当前文档目录；未保存文档（docPath=null）无基准，忽略
  if (!docPath || !isAbsolute(docPath)) return { action: 'none' };
  const target = isAbsolute(cls.path) ? resolve(cls.path) : resolve(dirname(docPath), cls.path);
  if (!existsSync(target)) return { action: 'none' }; // 死链静默忽略（不弹错误框）
  let isFile = false;
  try {
    isFile = statSync(target).isFile();
  } catch {
    return { action: 'none' };
  }
  if (!isFile) return { action: 'none' }; // 目录不打开（防误开文件夹）
  if (isOpenablePath(target)) return { action: 'open-window', path: target };
  if (systemOpenable(target)) return { action: 'open-system', path: target };
  return { action: 'none' };
}
