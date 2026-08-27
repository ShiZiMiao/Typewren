import { app, BrowserWindow } from 'electron'

import { createMainWindow } from './window'
import { attachNativeThemeSync, registerIpcHandlers } from './io'
import { installApplicationMenu, refreshApplicationMenu, registerMenuPopup } from './menu'
import { checkForUpdates } from './updater'

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    registerIpcHandlers()
    installApplicationMenu()
    registerMenuPopup()
    attachNativeThemeSync(refreshApplicationMenu)
    mainWindow = createMainWindow()

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
