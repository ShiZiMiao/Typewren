import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface OpenFileResult {
  path: string
  content: string
}

export interface SaveAsResult {
  path: string
}

export interface TypewrenApi {
  readonly platform: NodeJS.Platform

  /** 弹出原生打开对话框，读取文件内容；取消或失败返回 null */
  openFileDialog(): Promise<OpenFileResult | null>

  /** 弹出原生另存为对话框并写入；取消或失败返回 null */
  saveFileDialog(payload: {
    content: string
    suggestedName?: string
  }): Promise<SaveAsResult | null>

  /** 直接写入已知路径；失败弹错误框并返回 false */
  writeFile(payload: { path: string; content: string }): Promise<boolean>

  /** 未保存时新建/打开前的确认，返回用户选择 */
  confirmDiscardChanges(): Promise<'save' | 'discard' | 'cancel'>

  /** 更新窗口标题 */
  setTitle(title: string): void

  /** 同步原生主题（影响标题栏/菜单栏/滚动条配色） */
  setNativeTheme(theme: 'light' | 'dark' | 'system'): void

  /**
   * 订阅原生主题变化（主进程 nativeTheme 'updated'）。
   * 参数为 shouldUseDarkColors；返回取消订阅函数。
   */
  onNativeThemeUpdated(callback: (dark: boolean) => void): () => void

  /** 同步脏状态到主进程（关闭保护用） */
  setDirty(dirty: boolean): void

  /** 渲染进程完成保存后请求真正关闭窗口 */
  requestForceClose(): void

  /** 在指定窗口坐标弹出某顶级菜单的子菜单（自绘菜单栏用） */
  popupMenu(label: string, x: number, y: number): void

  /**
   * 订阅主进程派发的命令（菜单/快捷键触发）。
   * 返回取消订阅函数。
   */
  onCommand(
    callback: (name: string, payload?: unknown) => void
  ): () => void

  /** 在新窗口中打开指定文件 */
  openFileInNewWindow(filePath: string): void

  /** 获取文件的绝对路径（用于拖拽文件） */
  getPathForFile(file: File): string

  /** 读取指定路径的文件内容 */
  readFileContent(filePath: string): Promise<OpenFileResult>
}

const api: TypewrenApi = {
  platform: process.platform,

  openFileDialog: () => ipcRenderer.invoke('dialog:open-file'),

  saveFileDialog: (payload) => ipcRenderer.invoke('dialog:save-as', payload),

  writeFile: (payload) => ipcRenderer.invoke('file:write', payload),

  confirmDiscardChanges: () => ipcRenderer.invoke('dialog:discard-changes'),

  setTitle: (title) => ipcRenderer.send('win:set-title', title),

  setNativeTheme: (theme) => ipcRenderer.send('theme:set-native', theme),

  onNativeThemeUpdated: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, dark: boolean): void =>
      callback(dark)
    ipcRenderer.on('theme:native-updated', handler)
    return () => ipcRenderer.off('theme:native-updated', handler)
  },

  setDirty: (dirty) => ipcRenderer.send('win:set-dirty', dirty),

  requestForceClose: () => ipcRenderer.send('win:request-force-close'),

  popupMenu: (label, x, y) =>
    ipcRenderer.send('menu:popup', { label, x, y }),

  onCommand: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      name: string,
      payload?: unknown
    ): void => callback(name, payload)
    ipcRenderer.on('cmd', handler)
    return () => ipcRenderer.off('cmd', handler)
  },

  openFileInNewWindow: (filePath) =>
    ipcRenderer.send('file:open-in-new-window', filePath),

  getPathForFile: (file) => webUtils.getPathForFile(file),

  readFileContent: (filePath) => ipcRenderer.invoke('file:read-content', filePath)
}

contextBridge.exposeInMainWorld('typewren', api)
