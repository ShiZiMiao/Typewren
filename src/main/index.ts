import { app, BrowserWindow, ipcMain } from 'electron'
import { promises as fsp } from 'node:fs'
import { extname } from 'node:path'

import { createMainWindow } from './window'
import { attachNativeThemeSync, registerIpcHandlers, sendCommand } from './io'
import { installApplicationMenu, refreshApplicationMenu, registerMenuPopup } from './menu'
import { checkForUpdates } from './updater'

const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdown'])

/** 从命令行参数中提取 Markdown 文件路径 */
function extractMarkdownPath(argv: string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    const ext = extname(arg).toLowerCase()
    if (MARKDOWN_EXTS.has(ext)) return arg
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
        void fsp.readFile(filePath, 'utf-8').then((content) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            sendCommand(mainWindow, 'open-file-path', { path: filePath, content })
          }
        })
      }
    }
  })

  app.whenReady().then(() => {
    registerIpcHandlers()
    installApplicationMenu()
    registerMenuPopup()
    attachNativeThemeSync(refreshApplicationMenu)
    mainWindow = createMainWindow()

    // ---------- 在新窗口中打开文件 ----------
    ipcMain.on('file:open-in-new-window', (_event, filePath: string) => {
      void fsp.readFile(filePath, 'utf-8').then((content) => {
        const newWin = createMainWindow()
        newWin.webContents.once('did-finish-load', () => {
          sendCommand(newWin, 'open-file-path', { path: filePath, content })
        })
      })
    })

    const filePath = extractMarkdownPath(process.argv)
    if (filePath) {
      mainWindow.webContents.once('did-finish-load', () => {
        void fsp.readFile(filePath, 'utf-8').then((content) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            sendCommand(mainWindow, 'open-file-path', { path: filePath, content })
          }
        })
      })
    }

    setTimeout(() => checkForUpdates(true), 3000)

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
