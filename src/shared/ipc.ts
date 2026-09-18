/* ============================================================
 * 主进程 ↔ 渲染进程共享：IPC 常量与载荷类型
 * 命令名 / 扩展名列表 / 文件载荷在主进程、preload、渲染层三端共用，
 * 避免各自内联重复定义导致漂移。
 * ============================================================ */

/** 可打开的 Markdown 扩展名（小写、带点） */
export const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown'] as const;

/** 判断路径是否为受支持的 Markdown 文件 */
export function isMarkdownPath(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = filePath.slice(dot).toLowerCase();
  return (MARKDOWN_EXTENSIONS as readonly string[]).includes(ext);
}

/** 文件对话框统一过滤器（扩展名由 MARKDOWN_EXTENSIONS 推导，去点） */
export const MD_FILTERS = [
  {
    name: 'Markdown 文档',
    extensions: MARKDOWN_EXTENSIONS.map((e) => e.slice(1))
  },
  { name: '文本文件', extensions: ['txt'] },
  { name: '所有文件', extensions: ['*'] }
];

/** 文件内容载荷（读取结果 / open-file-path 命令共用） */
export interface FileContentPayload {
  path: string;
  content: string;
}

/** 目录列表项（文件树面板用） */
export interface DirEntry {
  name: string;
  /** 相对目录的路径（绝对路径由主进程拼接后返回，渲染层不自行拼） */
  fullPath: string;
  isDir: boolean;
  isMarkdown: boolean;
}

/** 文件树面板列目录请求 */
export interface ListDirPayload {
  /** 当前文档绝对路径；主进程以此为根校验 dirPath 越权 */
  docPath: string;
  /** 要列的目录；必须是 docPath 所在目录或其子目录 */
  dirPath: string;
}

export type OpenFileResult = FileContentPayload;

/**
 * 待打开文件（渲染进程就绪后经 file:take-pending-open 领取）。
 * restore=true 表示来自崩溃恢复：加载后文档须相对磁盘基线置脏。
 */
export interface PendingOpenResult extends FileContentPayload {
  restore?: boolean;
}

/** 自绘对话框的通用确认参数（dialog:confirm） */
export interface ConfirmDialogPayload {
  message: string;
  detail?: string;
  buttons: string[];
  /** 按 Esc / 关窗视为选中的按钮下标 */
  cancelId?: number;
}

/**
 * 另存为后迁移附件：主进程从 fromDoc 所在目录的 assets/ 复制到
 * toDoc 所在目录的 assets/（渲染层只传文档路径，目录仍由主进程推导）。
 */
export interface AssetsCopyPayload {
  fromDoc: string;
  toDoc: string;
}

export interface AssetsCopyResult {
  ok: boolean;
  copied?: number;
  error?: string;
}

export function isAssetsCopyPayload(value: unknown): value is AssetsCopyPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { fromDoc, toDoc } = value as Record<string, unknown>;
  return typeof fromDoc === 'string' && typeof toDoc === 'string';
}

/** 崩溃恢复草稿（userData/drafts 下一条记录） */
export interface DraftRecord {
  /** 文档路径；空串表示未命名文档 */
  path: string;
  content: string;
  savedAt: number;
}

export function isConfirmDialogPayload(value: unknown): value is ConfirmDialogPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { message, detail, buttons, cancelId } = value as Record<string, unknown>;
  return (
    typeof message === 'string' &&
    Array.isArray(buttons) &&
    buttons.length > 0 &&
    buttons.every((b) => typeof b === 'string') &&
    (detail === undefined || typeof detail === 'string') &&
    (cancelId === undefined || typeof cancelId === 'number')
  );
}

export function isDraftSavePayload(value: unknown): value is { path: string; content: string } {
  if (typeof value !== 'object' || value === null) return false;
  const { path, content } = value as Record<string, unknown>;
  return typeof path === 'string' && typeof content === 'string';
}

export interface SaveAsResult {
  path: string;
}

export interface SaveAsPayload {
  content: string;
  suggestedName?: string;
}

/** 导出文档载荷（渲染层已拼好完整 HTML 页面，主进程负责写盘 / 打印） */
export interface ExportDocumentPayload {
  kind: 'pdf' | 'html' | 'docx' | 'png';
  /** 完整 HTML 文档字符串（含内联样式，KaTeX 字体待主进程内联）；docx/png 时可用 */
  html: string;
  /** 导出对话框的默认文件名（含扩展名） */
  suggestedName: string;
  /** kind=docx 时的结构化块序列（主进程用 docx 库构造） */
  docxBlocks?: unknown;
}

export interface ExportDocumentResult {
  ok: boolean;
  /** 用户在另存为对话框中取消 */
  canceled?: boolean;
  error?: string;
}

/** 可保存的图片扩展名（小写、带点） */
export const IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico',
  '.tif',
  '.tiff'
] as const;

/** 文件名是否为受支持的图片 */
export function isImagePath(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = fileName.slice(dot).toLowerCase();
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext);
}

/** 文件是否为图片（File.type 命中或扩展名命中） */
export function isImageFile(file: { type?: string; name: string }): boolean {
  return (file.type ?? '').startsWith('image/') || isImagePath(file.name);
}

/** 从本地路径复制图片（paste/drop 从文件系统来） */
export interface ImageSaveFromPathPayload {
  srcPath: string;
  /** 文档绝对路径；主进程据此推导同目录 assets 落盘。null 表示未保存文档（用用户数据区） */
  docPath: string | null;
}

/** 以 base64 保存图片（剪贴板截图 / 网页图片等无路径来源） */
export interface ImageSaveFromDataPayload {
  base64: string;
  mime: string;
  docPath: string | null;
}

/** 下载网络图片并本地化保存 */
export interface ImageDownloadPayload {
  url: string;
  docPath: string | null;
}

export interface ImageSaveResult {
  ok: boolean;
  /** 保存后的绝对路径（渲染层据此生成 Markdown 引用） */
  savedPath?: string;
  error?: string;
}

/** open-file-path 等文件载荷的类型守卫（替代裸断言） */
export function isFileContentPayload(value: unknown): value is FileContentPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { path, content } = value as { path?: unknown; content?: unknown };
  return typeof path === 'string' && typeof content === 'string';
}

/** 另存为载荷的类型守卫（file:write 之外的保存对话框入参） */
export function isSaveAsPayload(value: unknown): value is SaveAsPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { content, suggestedName } = value as {
    content?: unknown;
    suggestedName?: unknown;
  };
  return (
    typeof content === 'string' &&
    (suggestedName === undefined || typeof suggestedName === 'string')
  );
}

/** 导出载荷的类型守卫（kind / html / suggestedName 逐项校验） */
export function isExportDocumentPayload(value: unknown): value is ExportDocumentPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { kind, html, suggestedName, docxBlocks } = value as {
    kind?: unknown;
    html?: unknown;
    suggestedName?: unknown;
    docxBlocks?: unknown;
  };
  return (
    (kind === 'pdf' || kind === 'html' || kind === 'docx' || kind === 'png') &&
    typeof html === 'string' &&
    typeof suggestedName === 'string' &&
    (kind !== 'docx' || Array.isArray(docxBlocks))
  );
}

/** docPath 字段：绝对路径字符串或 null（未保存文档） */
export function isDocPath(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function isImageSaveFromPathPayload(value: unknown): value is ImageSaveFromPathPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { srcPath, docPath } = value as { srcPath?: unknown; docPath?: unknown };
  return typeof srcPath === 'string' && isDocPath(docPath);
}

export function isImageSaveFromDataPayload(value: unknown): value is ImageSaveFromDataPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { base64, mime, docPath } = value as {
    base64?: unknown;
    mime?: unknown;
    docPath?: unknown;
  };
  return typeof base64 === 'string' && typeof mime === 'string' && isDocPath(docPath);
}

export function isImageDownloadPayload(value: unknown): value is ImageDownloadPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { url, docPath } = value as { url?: unknown; docPath?: unknown };
  return typeof url === 'string' && isDocPath(docPath);
}

/**
 * 更新下载状态（主进程 → 渲染层 `updater:download-state` 推送）。
 * 渲染层据此展示下载进度提示卡；phase 为状态机推进方向：
 * starting → progress → done / canceled / error。
 */
export type UpdateDownloadState =
  | { phase: 'starting'; version: string }
  | {
      phase: 'progress';
      version: string;
      /** 0-100 的整数百分比 */
      percent: number;
      /** 已下载字节 */
      transferred: number;
      /** 总字节（未知时为 0） */
      total: number;
      /** 实时下载速度（字节/秒） */
      bytesPerSecond: number;
    }
  | { phase: 'done'; version: string }
  | { phase: 'canceled' }
  | { phase: 'error'; message: string };

/** 更新下载状态载荷的类型守卫（preload 收主进程推送时过滤） */
export function isUpdateDownloadState(value: unknown): value is UpdateDownloadState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Record<string, unknown>;
  switch (state.phase) {
    case 'starting':
      return typeof state.version === 'string';
    case 'progress':
      return (
        typeof state.version === 'string' &&
        typeof state.percent === 'number' &&
        typeof state.transferred === 'number' &&
        typeof state.total === 'number' &&
        typeof state.bytesPerSecond === 'number'
      );
    case 'done':
      return typeof state.version === 'string';
    case 'canceled':
      return true;
    case 'error':
      return typeof state.message === 'string';
    default:
      return false;
  }
}

/** 菜单命令名：主进程发送端与渲染层路由接收端共用，防拼写漂移 */
export type CommandName =
  | 'new-file'
  | 'open-file'
  | 'save'
  | 'save-as'
  | 'save-and-close'
  | 'discard-close'
  | 'export:pdf'
  | 'export:html'
  | 'export:docx'
  | 'export:png'
  | 'open-file-path'
  | 'format:bold'
  | 'format:italic'
  | 'format:strike'
  | 'format:inline-code'
  | 'format:link'
  | 'format:image'
  | 'heading'
  | 'list:bullet'
  | 'list:number'
  | 'list:task'
  | 'block:quote'
  | 'block:code'
  | 'block:math'
  | 'block:math-inline'
  | 'insert:table'
  | 'insert:hr'
  | 'edit:find'
  | 'edit:replace'
  | 'view:source'
  | 'view:outline'
  | 'view:theme'
  | 'view:focus-mode'
  | 'view:typewriter-mode'
  | 'view:background-settings'
  | 'edit:spellcheck'
  | 'edit:auto-pairs'
  | 'file:open-smart'
  | 'global:show-in-folder';
