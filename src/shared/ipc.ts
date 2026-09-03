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

export type OpenFileResult = FileContentPayload;

export interface SaveAsResult {
  path: string;
}

export interface SaveAsPayload {
  content: string;
  suggestedName?: string;
}

/** 导出文档载荷（渲染层已拼好完整 HTML 页面，主进程负责写盘 / 打印） */
export interface ExportDocumentPayload {
  kind: 'pdf' | 'html';
  /** 完整 HTML 文档字符串（含内联样式，KaTeX 字体待主进程内联） */
  html: string;
  /** 导出对话框的默认文件名（含扩展名） */
  suggestedName: string;
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
  const { kind, html, suggestedName } = value as {
    kind?: unknown;
    html?: unknown;
    suggestedName?: unknown;
  };
  return (
    (kind === 'pdf' || kind === 'html') &&
    typeof html === 'string' &&
    typeof suggestedName === 'string'
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

/** 菜单命令名：主进程发送端与渲染层路由接收端共用，防拼写漂移 */
export type CommandName =
  | 'new-file'
  | 'open-file'
  | 'save'
  | 'save-as'
  | 'save-and-close'
  | 'export:pdf'
  | 'export:html'
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
  | 'view:theme';
