import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { app, BrowserWindow, dialog, nativeTheme, screen, shell } from 'electron';

import { attachCloseGuard } from './closeGuard';
import { registerPendingOpen, sendCommand } from './io';
import { attachZoomShortcuts } from './zoom';
import { findWindowByDoc, scheduleSessionSave } from './docRegistry';
import { isTestMode, suppressesUi } from './runMode';
import { pathKey } from '../shared/pathKey';
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
  // 连开多个不至于完全叠死；偏移钳入显示器工作区——一直 +40 级联会走出屏幕
  // （负坐标/顶进任务栏），整只落在屏幕外时用户以为"没开出来"
  if (lastPlacement) {
    const { width, height } = lastPlacement;
    let x = lastPlacement.x + 40;
    let y = lastPlacement.y + 40;
    const area = screen.getDisplayMatching({ x, y, width, height }).workArea;
    x = Math.min(Math.max(x, area.x), area.x + area.width - width);
    y = Math.min(Math.max(y, area.y), area.y + area.height - height);
    win.setBounds({ x, y, width, height });
    lastPlacement = { x, y, width, height };
  } else {
    const b = win.getBounds();
    lastPlacement = { x: b.x, y: b.y, width: b.width, height: b.height };
  }

  // 测试/后台运行不显示窗口：DOM/渲染照常工作但绝不抢占用户前台焦点。
  // --test（launchApp 主路径）与 --headless（真实实例测试：关闭保护/草稿/会话）
  // 都抑制显示，但只有前者会跳过关闭保护等交互（见 runMode.ts）。
  if (!suppressesUi()) {
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

  // 页面导航守卫：编辑器窗口绝不允许被导航离开应用（窗口被外部内容接管 = 钓鱼面）。
  // 只放行自身页面：dev HMR 的全量 reload 会走 will-navigate（ELECTRON_RENDERER_URL 前缀），
  // 打包态只认自己的 renderer/index.html；will-redirect（meta 跳转/服务端 302）同口径拦
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  const selfUrl = pathToFileURL(join(__dirname, '../renderer', 'index.html')).href;
  const allowNavigation = (url: string): boolean =>
    (!!devUrl && url.startsWith(devUrl)) || url.startsWith(selfUrl);
  win.webContents.on('will-navigate', (event, url) => {
    if (!allowNavigation(url)) event.preventDefault();
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!allowNavigation(url)) event.preventDefault();
  });

  attachCloseGuard(win, sendCommand);
  // 缩放快捷键抢占层（before-input-event，先于页面与菜单加速器）
  attachZoomShortcuts(win.webContents);

  // 启动标志经 URL query 传给 preload（沙箱 preload 拿不到 process.argv/env）
  const launchParams = new URLSearchParams();
  if (isTestMode()) launchParams.set('twtest', '1');
  const draftArg = process.argv.find((a) => a.startsWith('--draft-interval='));
  if (draftArg) launchParams.set('draft', draftArg.slice('--draft-interval='.length));

  // 加载失败必须显式收场：void 掉 Promise 的旧写法失败时留下一个永不显示的
  // 隐藏窗（--test/--headless 下连用户都看不到"没开出来"）。
  // 先收掉坏窗再用**异步**框提示：showErrorBox 同步阻塞主进程（多窗口全卡，
  // 自动化环境无人点掉它会一直挂着，同 AGENTS 决策 #15 的同步框坑家族）
  const failLoad = (error: unknown): void => {
    if (win.isDestroyed()) return;
    win.destroy();
    void dialog.showMessageBox({
      type: 'error',
      title: 'Typewren',
      message: '无法加载编辑器界面',
      detail: String(error),
      buttons: ['确定']
    });
  };
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    // -3 = ERR_ABORTED（重定向/主动取消的正常中止），不算失败
    if (!isMainFrame || errorCode === -3) return;
    failLoad(`${errorDescription}（错误码 ${errorCode}）`);
  });

  if (!app.isPackaged && devUrl) {
    const url = new URL(devUrl);
    for (const [key, value] of launchParams) url.searchParams.set(key, value);
    win.loadURL(url.toString()).catch(failLoad);
  } else {
    win
      .loadFile(join(__dirname, '../renderer/index.html'), {
        query: Object.fromEntries(launchParams)
      })
      .catch(failLoad);
  }

  return win;
}

/** 同路径"正在打开"的在途占位（见 openFileInNewWindow） */
const openingKeys = new Set<string>();

/**
 * 在新窗口打开文件；若该文档已有窗口打开，先询问（跳转到已有 / 仍新开）。
 * parent 为发起请求的窗口（拖拽/最近文件菜单），无则回退到已开窗口。
 *
 * 并发口径：查重与登记必须落在同一同步临界区（其间不得 await）——查重之后若
 * 隔着「重复打开询问」对话框的 await 再登记，同路径两次快速调用会双双判
 * "无重复"而双开对写（两个窗口保存同一文件互相覆盖）。在途占位挡下并发调用，
 * 建窗后立即登记再二次校验，兜住启动规划/second-instance 直建窗口的时序缝隙。
 */
export async function openFileInNewWindow(
  parent: BrowserWindow | null,
  filePath: string
): Promise<void> {
  const absolute = resolve(filePath);
  const key = pathKey(absolute);
  if (openingKeys.has(key)) return;
  openingKeys.add(key);
  try {
    // 入参时刻已知的重复窗口：用户选「仍在新窗口打开」时它与新窗并存是预期行为，
    // 二次校验不得把它误判成"并发抢先"
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
    // ---- 同步临界区开始：建窗 + 登记一气呵成（登记即判重数据源） ----
    const win = createMainWindow();
    registerPendingOpen(win, absolute, { recent: true });
    // 二次校验：问询对话框的 await 期间可能有先行者（second-instance/启动规划）
    // 完成登记——命中窗口既不是入参时已知的 existing、也不是本窗，才判"并发抢先"，
    // 收敛到先行者；绝不能把用户明确选择的"仍开新窗"当重复销毁
    const dup = findWindowByDoc(absolute);
    if (dup && dup !== win && dup !== existing && !dup.isDestroyed()) {
      win.destroy();
      if (dup.isMinimized()) dup.restore();
      dup.focus();
    }
    // ---- 同步临界区结束 ----
  } finally {
    openingKeys.delete(key);
  }
}
