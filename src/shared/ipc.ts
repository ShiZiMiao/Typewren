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