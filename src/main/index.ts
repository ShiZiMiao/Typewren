import { app, BrowserWindow, ipcMain } from 'electron';

import { createMainWindow, openFileInNewWindow } from './window';
import { attachNativeThemeSync, registerIpcHandlers, registerPendingOpen } from './io';
import { installApplicationMenu, refreshApplicationMenu, registerMenuPopup } from './menu';
import { registerExportHandlers } from './export';
import { registerImageHandlers, registerImageProtocol } from './images';
import { consumeDrafts, registerDraftHandlers } from './drafts';
import { applyStartupSettings, registerSettingsIpc } from './settings';
import { flushSessionSave, loadRecentFiles, onRecentsChanged } from './docRegistry';
import { takeSession } from './session';
import { planStartupWindows } from './startup';
import { checkForUpdates, registerUpdaterIpc } from './updater';
import { isMarkdownPath } from '../shared/ipc';

/** 启动后自动检查更新的延迟 */
const UPDATE_CHECK_DELAY_MS = 3000;

/** 从命令行参数中提取 Markdown 文件路径 */
function extractMarkdownPath(argv: string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue;
    if (isMarkdownPath(arg)) return arg;
  }
  return null;
}

// 允许用 --user-data-dir=<dir> 隔离用户数据目录（测试用，须在单实例锁之前设置，
// 锁文件位于 userData 内）
const userDataArg = process.argv.find((a) => a.startsWith('--user-data-dir='));
if (userDataArg) {
  app.setPath('userData', userDataArg.slice('--user-data-dir='.length));
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const filePath = extractMarkdownPath(argv);
    if (filePath) {
      // 多窗口形态：外部打开（双击文件 / 命令行启动）总是新开窗口（重复打开会询问）
      if (app.isReady()) {
        void openFileInNewWindow(null, filePath);
      } else {
        void app.whenReady().then(() => openFileInNewWindow(null, filePath));
      }
      return;
    }
    // 无文件参数：聚焦/恢复现有窗口，一个都没有则重建
    const wins = BrowserWindow.getAllWindows();
    const target = BrowserWindow.getFocusedWindow() ?? wins[wins.length - 1];
    if (target) {
      if (target.isMinimized()) target.restore();
      target.focus();
    } else {
      createMainWindow();
    }
  });

  app.whenReady().then(() => {
    registerIpcHandlers();
    registerExportHandlers();
    registerImageHandlers();
    // 图片加载协议须在窗口加载内容之前注册（渲染层 <img> 按此解析本地图片）
    registerImageProtocol();
    registerDraftHandlers();
    registerUpdaterIpc();
    registerSettingsIpc();

    loadRecentFiles();
    onRecentsChanged(refreshApplicationMenu);
    installApplicationMenu();
    registerMenuPopup();
    attachNativeThemeSync(refreshApplicationMenu);
    // 应用持久化设置须在建窗前：窗口底色与拼写检查从一开始就正确
    applyStartupSettings();

    // ---------- 新窗口打开（渲染层拖拽/最近文件等发起；重复打开询问） ----------
    ipcMain.on('file:open-in-new-window', (event, filePath: string) => {
      // 只放行受支持的 Markdown 路径（拖拽/命令行打开场景）
      if (typeof filePath !== 'string' || !isMarkdownPath(filePath)) return;
      void openFileInNewWindow(BrowserWindow.fromWebContents(event.sender), filePath);
    });

    // ---------- 启动窗口规划：命令行文件 > 崩溃草稿 > 上次会话 ----------
    const plan = planStartupWindows(
      extractMarkdownPath(process.argv),
      consumeDrafts(),
      takeSession()
    );
    const firstWin = createMainWindow();
    const [head, ...rest] = plan;
    if (head) {
      registerPendingOpen(firstWin, head.path, head.content, head.restore);
    }
    for (const entry of rest) {
      const win = createMainWindow();
      registerPendingOpen(win, entry.path, entry.content, entry.restore);
    }

    setTimeout(() => checkForUpdates(true), UPDATE_CHECK_DELAY_MS);

    app.on('activate', () => {
      // macOS: 点击 Dock 图标时若无窗口则重建
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  app.on('before-quit', () => {
    // 带窗退出：此刻窗口仍在，立即落盘完整窗口集合（不等防抖）。
    // 用户逐个关窗后再退出时，before-quit 拿到空集合——同样正确（关窗即不再需要）
    flushSessionSave();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
