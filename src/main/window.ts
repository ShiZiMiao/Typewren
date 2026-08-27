import { join } from 'node:path'

import { app, BrowserWindow, shell } from 'electron'

import { attachCloseGuard } from './io'

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Typewren',
    backgroundColor: '#f8f9fb',
    autoHideMenuBar: false,
    // 开发模式下宿主是无图标的裸 electron.exe，需显式指定；
    // 打包后 exe 已内嵌 build/icon.ico，缺省即用 exe 图标
    ...(!app.isPackaged && {
      icon: join(app.getAppPath(), 'build', 'icon.png')
    }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // 外部链接一律交给系统默认浏览器，绝不在应用内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  attachCloseGuard(win)

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}
