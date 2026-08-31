import type {
  CommandName,
  FileContentPayload,
  OpenFileResult,
  SaveAsPayload,
  SaveAsResult
} from '../../shared/ipc'

export {}

export interface TypewrenApi {
  readonly platform: NodeJS.Platform

  openFileDialog(): Promise<OpenFileResult | null>

  saveFileDialog(payload: SaveAsPayload): Promise<SaveAsResult | null>

  writeFile(payload: FileContentPayload): Promise<boolean>

  confirmDiscardChanges(): Promise<'save' | 'discard' | 'cancel'>

  setTitle(title: string): void

  setNativeTheme(theme: 'light' | 'dark' | 'system'): void

  onNativeThemeUpdated(callback: (dark: boolean) => void): () => void

  setDirty(dirty: boolean): void

  requestForceClose(): void

  /** 在指定窗口坐标弹出某顶级菜单的子菜单（自绘菜单栏用） */
  popupMenu(label: string, x: number, y: number): void

  onCommand(callback: (name: CommandName, payload?: unknown) => void): () => void

  /** 在新窗口中打开指定文件 */
  openFileInNewWindow(filePath: string): void

  /** 获取文件的绝对路径（用于拖拽文件） */
  getPathForFile(file: File): string

  /** 读取指定路径的文件内容；失败返回 null */
  readFileContent(filePath: string): Promise<OpenFileResult | null>
}

declare global {
  interface Window {
    typewren: TypewrenApi
  }
}