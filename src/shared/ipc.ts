/* ============================================================
 * 主进程 ↔ 渲染进程共享：IPC 常量与载荷类型
 * 命令名 / 扩展名列表 / 文件载荷在主进程、preload、渲染层三端共用，
 * 避免各自内联重复定义导致漂移。
 * ============================================================ */

/** 可打开的 Markdown 扩展名（小写、带点） */
export const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown'] as const

/** 判断路径是否为受支持的 Markdown 文件 */
export function isMarkdownPath(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.')
  if (dot < 0) return false
  const ext = filePath.slice(dot).toLowerCase()
  return (MARKDOWN_EXTENSIONS as readonly string[]).includes(ext)
}

/** 文件对话框统一过滤器（扩展名由 MARKDOWN_EXTENSIONS 推导，去点） */
export const MD_FILTERS = [
  {
    name: 'Markdown 文档',
    extensions: MARKDOWN_EXTENSIONS.map((e) => e.slice(1))
  },
  { name: '文本文件', extensions: ['txt'] },
  { name: '所有文件', extensions: ['*'] }
]

/** 文件内容载荷（读取结果 / open-file-path 命令共用） */
export interface FileContentPayload {
  path: string
  content: string
}

export type OpenFileResult = FileContentPayload

export interface SaveAsResult {
  path: string
}

export interface SaveAsPayload {
  content: string
  suggestedName?: string
}

/** 导出文档载荷（渲染层已拼好完整 HTML 页面，主进程负责写盘 / 打印） */
export interface ExportDocumentPayload {
  kind: 'pdf' | 'html'
  /** 完整 HTML 文档字符串（含内联样式，KaTeX 字体待主进程内联） */
  html: string
  /** 导出对话框的默认文件名（含扩展名） */
  suggestedName: string
}

export interface ExportDocumentResult {
  ok: boolean
  /** 用户在另存为对话框中取消 */
  canceled?: boolean
  error?: string
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
] as const

/** 文件名是否为受支持的图片 */
export function isImagePath(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return false
  const ext = fileName.slice(dot).toLowerCase()
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext)
}

/** 文件是否为图片（File.type 命中或扩展名命中） */
export function isImageFile(file: { type?: string; name: string }): boolean {
  return (file.type ?? '').startsWith('image/') || isImagePath(file.name)
}

/** 从本地路径复制图片（paste/drop 从文件系统来） */
export interface ImageSaveFromPathPayload {
  srcPath: string
  /** 目标目录（文档同目录 assets）；null 表示文档尚无路径，用用户数据区默认目录 */
  destDir: string | null
}

/** 以 base64 保存图片（剪贴板截图 / 网页图片等无路径来源） */
export interface ImageSaveFromDataPayload {
  base64: string
  mime: string
  destDir: string | null
}

/** 下载网络图片并本地化保存 */
export interface ImageDownloadPayload {
  url: string
  destDir: string | null
}

export interface ImageSaveResult {
  ok: boolean
  /** 保存后的绝对路径（渲染层据此生成 Markdown 引用） */
  savedPath?: string
  error?: string
}

/** open-file-path 等文件载荷的类型守卫（替代裸断言） */
export function isFileContentPayload(
  value: unknown
): value is FileContentPayload {
  if (typeof value !== 'object' || value === null) return false
  const { path, content } = value as { path?: unknown; content?: unknown }
  return typeof path === 'string' && typeof content === 'string'
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
  | 'view:theme'