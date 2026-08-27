import { BrowserWindow, ipcMain, dialog, nativeTheme } from 'electron'
import { promises as fsp } from 'node:fs'

/** 每个窗口的脏状态（渲染进程通过 IPC 同步） */
const dirtyMap = new WeakMap<BrowserWindow, boolean>()
/** 已确认强制关闭（跳过保存保护） */
const forceCloseSet = new WeakSet<BrowserWindow>()

const MD_FILTERS = [
  { name: 'Markdown 文档', extensions: ['md', 'markdown', 'mdown'] },
  { name: '文本文件', extensions: ['txt'] },
  { name: '所有文件', extensions: ['*'] }
]

function winOf(sender: Electron.WebContents): BrowserWindow | null {
  return BrowserWindow.fromWebContents(sender)
}

/** 向指定窗口的渲染进程派发一条命令 */
export function sendCommand(
  win: BrowserWindow,
  name: string,
  payload?: unknown
): void {
  if (!win.isDestroyed()) win.webContents.send('cmd', name, payload)
}

/**
 * 关闭保护：文档未保存时拦截关闭请求，
 * 弹出原生对话框让用户选择 保存 / 不保存 / 取消。
 * 选择"保存"后由渲染进程完成保存并回调 request-force-close。
 */
export function attachCloseGuard(win: BrowserWindow): void {
  win.on('close', (event) => {
    if (!dirtyMap.get(win) || forceCloseSet.has(win)) return

    event.preventDefault()

    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'Typewren',
      message: '文档尚未保存',
      detail: '你的更改将在关闭后丢失。是否保存更改？',
      buttons: ['保存', '不保存', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    })

    if (choice === 0) {
      // 让渲染进程先执行保存流程（无路径时会另存为），完成后回调
      sendCommand(win, 'save-and-close')
    } else if (choice === 1) {
      forceCloseSet.add(win)
      win.close()
    }
    // choice === 2：取消，什么都不做
  })
}

export function registerIpcHandlers(): void {
  // ---------- 打开文件 ----------
  ipcMain.handle('dialog:open-file', async (event) => {
    const win = winOf(event.sender)
    if (!win) return null

    const result = await dialog.showOpenDialog(win, {
      title: '打开 Markdown 文件',
      properties: ['openFile'],
      filters: MD_FILTERS
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const filePath = result.filePaths[0]
    try {
      const content = await fsp.readFile(filePath, 'utf-8')
      return { path: filePath, content }
    } catch (error) {
      dialog.showErrorBox('无法读取文件', String(error))
      return null
    }
  })

  // ---------- 另存为 ----------
  ipcMain.handle(
    'dialog:save-as',
    async (
      event,
      payload: { content: string; suggestedName?: string }
    ) => {
      const win = winOf(event.sender)
      if (!win) return null

      const result = await dialog.showSaveDialog(win, {
        title: '另存为',
        defaultPath: payload.suggestedName ?? '未命名.md',
        filters: MD_FILTERS
      })
      if (result.canceled || !result.filePath) return null

      try {
        await fsp.writeFile(result.filePath, payload.content, 'utf-8')
        return { path: result.filePath }
      } catch (error) {
        dialog.showErrorBox('无法写入文件', String(error))
        return null
      }
    }
  )

  // ---------- 直接写文件（已知路径的保存） ----------
  ipcMain.handle(
    'file:write',
    async (_event, payload: { path: string; content: string }) => {
      try {
        await fsp.writeFile(payload.path, payload.content, 'utf-8')
        return true
      } catch (error) {
        dialog.showErrorBox('无法保存文件', String(error))
        return false
      }
    }
  )

  // ---------- 放弃更改确认（新建 / 打开前调用） ----------
  ipcMain.handle('dialog:discard-changes', (event) => {
    const win = winOf(event.sender)
    if (!win) return 'cancel'

    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'Typewren',
      message: '当前文档尚未保存',
      detail: '是否保存当前更改？',
      buttons: ['保存', '放弃更改', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    })

    return choice === 0 ? 'save' : choice === 1 ? 'discard' : 'cancel'
  })

  // ---------- 窗口元信息 ----------
  ipcMain.on('win:set-title', (event, title: string) => {
    const win = winOf(event.sender)
    if (win && typeof title === 'string') win.setTitle(title)
  })

  ipcMain.on('win:set-dirty', (event, dirty: boolean) => {
    const win = winOf(event.sender)
    if (win) dirtyMap.set(win, Boolean(dirty))
  })

  ipcMain.on('win:request-force-close', (event) => {
    const win = winOf(event.sender)
    if (!win) return
    forceCloseSet.add(win)
    dirtyMap.set(win, false)
    win.close()
  })

  // ---------- 原生主题联动（标题栏 / 菜单栏 / 原生控件配色） ----------
  ipcMain.on('theme:set-native', (_event, theme: string) => {
    if (theme === 'light' || theme === 'dark' || theme === 'system') {
      nativeTheme.themeSource = theme
    }
  })
}

/**
 * 原生主题同步桥：nativeTheme 一旦变化（用户切换或系统偏好变化），
 * 立即广播 shouldUseDarkColors 给所有渲染进程，作为内容配色的统一时钟；
 * Windows 上同时强制重建菜单栏并触发非客户区重绘，避免标题栏 / 菜单栏迟一拍才变色。
 */
export function attachNativeThemeSync(refreshMenu: () => void): void {
  nativeTheme.on('updated', () => {
    const dark = nativeTheme.shouldUseDarkColors
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.webContents.send('theme:native-updated', dark)
      // 强制重设标题触发 DWM 非客户区按新主题重绘（零视觉副作用）
      if (process.platform === 'win32') win.setTitle(win.getTitle())
    }
    if (process.platform === 'win32') refreshMenu()
  })
}
