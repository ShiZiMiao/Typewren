import { app, BrowserWindow, ipcMain } from 'electron'

import { createMainWindow } from './window'
import { attachNativeThemeSync, openPathInWindow, registerIpcHandlers } from './io'
import { installApplicationMenu, refreshApplicationMenu, registerMenuPopup } from './menu'
import { registerExportHandlers } from './export'
import { registerImageHandlers } from './images'
import { checkForUpdates } from './updater'
import { isMarkdownPath } from '../shared/ipc'

/** 启动后自动检查更新的延迟 */
const UPDATE_CHECK_DELAY_MS = 3000

/** 从命令行参数中提取 Markdown 文件路径 */
function extractMarkdownPath(argv: string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    if (isMarkdownPath(arg)) return arg
  }
  return null
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null

  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      const filePath = extractMarkdownPath(argv)
      if (filePath) {
        void openPathInWindow(mainWindow, filePath)
      }
    }
  })

  app.whenReady().then(() => {
    registerIpcHandlers()
    registerExportHandlers()
    registerImageHandlers()
    installApplicationMenu()
    registerMenuPopup()
    attachNativeThemeSync(refreshApplicationMenu)
    mainWindow = createMainWindow()

    // ---------- 在新窗口中打开文件 ----------
    ipcMain.on('file:open-in-new-window', (_event, filePath: string) => {
      if (typeof filePath !== 'string') return
      const newWin = createMainWindow()
      newWin.webContents.once('did-finish-load', () => {
        void openPathInWindow(newWin, filePath)
      })
    })

    const filePath = extractMarkdownPath(process.argv)
    if (filePath) {
      mainWindow.webContents.once('did-finish-load', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          void openPathInWindow(mainWindow, filePath)
        }
      })
    }

    setTimeout(() => checkForUpdates(true), UPDATE_CHECK_DELAY_MS)

    app.on('activate', () => {
      // macOS: 点击 Dock 图标时若无窗口则重建
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
