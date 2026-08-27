import { join } from 'node:path'

import { app, BrowserWindow, shell } from 'electron'

import { attachCloseGuard } from './io'
import { TITLEBAR_PALETTE } from '../shared/titlebar'

export function createMainWindow(): BrowserWindow {
  const winOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Typewren',
    backgroundColor: '#f8f9fb',
    // 原生标题栏隐藏后由渲染层自绘标题栏（titleBarOverlay 即时上色，
    // 规避 Windows DWM 对原生标题栏约 70ms 的颜色渐变），故原生菜单栏也隐藏，
    // 仍可通过 Alt 唤出、快捷键不受影响
    autoHideMenuBar: true,
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
  }

  // 仅 Windows 启用 titleBarOverlay：以我们指定的底色即时绘制标题栏按钮区，
  // 不再依赖 nativeTheme 驱动原生标题栏（那是 70ms 渐变的来源）
  if (process.platform === 'win32') {
    winOptions.titleBarStyle = 'hidden'
    winOptions.titleBarOverlay = {
      color: TITLEBAR_PALETTE.light.color,
      symbolColor: TITLEBAR_PALETTE.light.symbolColor
    }
  }

  const win = new BrowserWindow(winOptions)

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
