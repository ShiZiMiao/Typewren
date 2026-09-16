import { join, resolve } from 'node:path';

import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron';

import { attachCloseGuard, registerPendingOpen } from './io';
import { findWindowByDoc, scheduleSessionSave } from './docRegistry';
import { TITLEBAR_PALETTE } from '../shared/titlebar';

/** 上一个新建窗口的位置/尺寸（级联布局用，进程生命周期内有效） */
let lastPlacement: { x: number; y: number; width: number; height: number } | null = null;

/** 默认窗口尺寸与最小尺寸 */
const WINDOW_WIDTH = 1200;
const WINDOW_HEIGHT = 800;
const WINDOW_MIN_WIDTH = 720;
const WINDOW_MIN_HEIGHT = 480;

export function createMainWindow(): BrowserWindow {
  // 初始配色跟随当前主题（而非硬编码浅色），避免暗色主题下新建窗口首帧闪白
  const dark = nativeTheme.shouldUseDarkColors;
  const palette = dark ? TITLEBAR_PALETTE.dark : TITLEBAR_PALETTE.light;
  const winOptions: Electron.BrowserWindowConstructorOptions = {
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false,
    title: 'Typewren',
    // 与 variables.css 的 --bg-soft 保持同步
    backgroundColor: dark ? '#23282e' : '#f8f9fb',
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
  };

  // 仅 Windows 启用 titleBarOverlay：以我们指定的底色即时绘制标题栏按钮区，
  // 不再依赖 nativeTheme 驱动原生标题栏（那是 70ms 渐变的来源）
  if (process.platform === 'win32') {
    winOptions.titleBarStyle = 'hidden';
    winOptions.titleBarOverlay = {
      color: palette.color,
      symbolColor: palette.symbolColor
    };
  }

  const win = new BrowserWindow(winOptions);

  // 级联定位：新窗口相对上一个窗口右下偏移（首窗居中、其余继承上一个尺寸），
  // 连开多个不至于完全叠死
  if (lastPlacement) {
    const x = lastPlacement.x + 40;
    const y = lastPlacement.y + 40;
    win.setBounds({ x, y, width: lastPlacement.width, height: lastPlacement.height });
    lastPlacement = { x, y, width: lastPlacement.width, height: lastPlacement.height };
  } else {
    const b = win.getBounds();
    lastPlacement = { x: b.x, y: b.y, width: b.width, height: b.height };
  }

  // 测试模式（e2e）不显示窗口：DOM/渲染照常工作但绝不抢占用户前台焦点。
  // --test（launchApp 主路径）与 --headless（真实实例测试：关闭保护/草稿/会话）
  // 都抑制显示，但只有前者会跳过关闭保护等交互。
  const headless = process.argv.includes('--test') || process.argv.includes('--headless');
  if (!headless) {
    win.once('ready-to-show', () => win.show());
  }

  // 原生菜单栏彻底不可见（自绘菜单栏承载全部功能）：
  // autoHideMenuBar 只是"默认隐藏"，Windows 下按 Alt 仍会唤出原生菜单栏，
  // 用户会看到左上角冒出原生「视图」菜单（本次报告的问题根源）。
  // setMenuBarVisibility(false) 后 Alt 不应再唤出；应用菜单的 accelerator
  // 快捷键（Ctrl+S / Ctrl+B 等）仍然生效——它由 setApplicationMenu 承载，
  // 与"是否可见"无关。
  win.setMenuBarVisibility(false);
  win.on('closed', () => scheduleSessionSave());

  // 外部链接一律交给系统默认浏览器，绝不在应用内打开；
  // 仅放行 http/https，拒绝 file:/javascript: 等可被滥用的协议
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const protocol = new URL(url).protocol;
      if (protocol === 'http:' || protocol === 'https:') {
        void shell.openExternal(url);
      }
    } catch {
      // URL 解析失败（非法地址）一律忽略
    }
    return { action: 'deny' };
  });

  attachCloseGuard(win);

  // 启动标志经 URL query 传给 preload（沙箱 preload 拿不到 process.argv/env）
  const launchParams = new URLSearchParams();
  if (process.argv.includes('--test')) launchParams.set('twtest', '1');
  const draftArg = process.argv.find((a) => a.startsWith('--draft-interval='));
  if (draftArg) launchParams.set('draft', draftArg.slice('--draft-interval='.length));

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) {
    const url = new URL(devUrl);
    for (const [key, value] of launchParams) url.searchParams.set(key, value);
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: Object.fromEntries(launchParams)
    });
  }

  return win;
}

/**
 * 在新窗口打开文件；若该文档已有窗口打开，先询问（跳转到已有 / 仍新开）。
 * parent 为发起请求的窗口（拖拽/最近文件菜单），无则回退到已开窗口。
 */
export async function openFileInNewWindow(
  parent: BrowserWindow | null,
  filePath: string
): Promise<void> {
  const absolute = resolve(filePath);
  const existing = findWindowByDoc(absolute);
  if (existing && !existing.isDestroyed()) {
    const anchor = parent && !parent.isDestroyed() ? parent : existing;
    const { response } = await dialog.showMessageBox(anchor, {
      type: 'question',
      title: 'Typewren',
      message: '该文档已在其它窗口打开',
      detail: `"${absolute}" 当前已有窗口打开。要继续使用该窗口，还是再开一个？`,
      buttons: ['转到已有窗口', '仍在新窗口打开'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (response === 0) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return;
    }
  }
  const win = createMainWindow();
  registerPendingOpen(win, absolute);
}
