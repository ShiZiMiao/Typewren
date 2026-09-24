import { BrowserWindow, ipcMain, nativeTheme } from 'electron';

import { TITLEBAR_PALETTE } from '../shared/titlebar';

/* ============================================================
 * 原生主题桥（原 io.ts 拆出；io.ts 收敛为 IPC 注册层）：
 * - theme:set-native：渲染层把主题偏好写到 nativeTheme.themeSource
 *   （交互切换以 nativeTheme 为时钟，见 AGENTS 决策 #6）
 * - nativeTheme 'updated'：广播 shouldUseDarkColors 给全部窗口作为内容配色统一时钟，
 *   Windows 上同时重设 titleBarOverlay 配色 + 重建菜单栏（DWM 渐变规避，决策 #7）
 * ============================================================ */

/** 注册主题 IPC（theme:set-native） */
export function registerThemeIpc(): void {
  ipcMain.on('theme:set-native', (_event, theme: string) => {
    if (theme === 'light' || theme === 'dark' || theme === 'system') {
      nativeTheme.themeSource = theme;
    }
  });
}

/**
 * 原生主题同步桥：nativeTheme 一旦变化（用户切换或系统偏好变化），
 * 立即广播 shouldUseDarkColors 给所有渲染进程，作为内容配色的统一时钟；
 * Windows 上同时强制重建菜单栏并触发非客户区重绘，避免标题栏 / 菜单栏迟一拍才变色。
 */
export function attachNativeThemeSync(refreshMenu: () => void): void {
  nativeTheme.on('updated', () => {
    const dark = nativeTheme.shouldUseDarkColors;
    const palette = dark ? TITLEBAR_PALETTE.dark : TITLEBAR_PALETTE.light;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send('theme:native-updated', dark);
      if (process.platform === 'win32') {
        // 即时重设标题栏按钮区配色（程序化设置，无 DWM 渐变），
        // 使标题栏与内容同刻切换
        win.setTitleBarOverlay({
          color: palette.color,
          symbolColor: palette.symbolColor
        });
        // 强制重设标题触发 DWM 非客户区按新主题重绘（零视觉副作用）
        win.setTitle(win.getTitle());
      }
    }
    if (process.platform === 'win32') refreshMenu();
  });
}
