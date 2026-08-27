export {}

export interface OpenFileResult {
  path: string
  content: string
}

export interface SaveAsResult {
  path: string
}

export interface TypewrenApi {
  readonly platform: string

  openFileDialog(): Promise<OpenFileResult | null>

  saveFileDialog(payload: {
    content: string
    suggestedName?: string
  }): Promise<SaveAsResult | null>

  writeFile(payload: { path: string; content: string }): Promise<boolean>

  confirmDiscardChanges(): Promise<'save' | 'discard' | 'cancel'>

  setTitle(title: string): void

  setNativeTheme(theme: 'light' | 'dark' | 'system'): void

  onNativeThemeUpdated(callback: (dark: boolean) => void): () => void

  setDirty(dirty: boolean): void

  requestForceClose(): void

  /** 在指定窗口坐标弹出某顶级菜单的子菜单（自绘菜单栏用） */
  popupMenu(label: string, x: number, y: number): void

  onCommand(callback: (name: string, payload?: unknown) => void): () => void

  /** 在新窗口中打开指定文件 */
  openFileInNewWindow(filePath: string): void

  /** 获取文件的绝对路径（用于拖拽文件） */
  getPathForFile(file: File): string
}

declare global {
  interface Window {
    typewren: TypewrenApi
  }
}
