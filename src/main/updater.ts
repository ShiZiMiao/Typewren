import { app, dialog, BrowserWindow } from 'electron';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { autoUpdater } from 'electron-updater';

/* ============================================================
 * 更新检查：electron-updater（GitHub Releases 提供源）
 * - 自动检查 24h 间隔（userData 缓存上次成功时间），启动静默
 * - 手动检查（帮助 → 检查更新）不受间隔限制
 * - 发现新版：弹框确认 → 下载 → 完成后弹框「立即重启安装 / 稍后」
 * - 打包版才检查（unpackaged 即 dev/测试，自动返回）
 * 注意：未配置代码签名证书时，Windows 安装器会有 SmartScreen 提示，
 * 属签名证书问题，与更新器本身无关。
 * ============================================================ */

/** 自动检查间隔（避免每次启动都打更新源） */
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 上次检查时间戳缓存文件（userData 下） */
const LAST_CHECK_FILE = 'last-update-check.json';

/** 当前检查是否静默（决定错误/结果是否弹框） */
let checkSilent = true;
/** 事件只注册一次（防止重复订阅导致多弹框） */
let eventsRegistered = false;

function activeWindow(): BrowserWindow | null {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  return win && !win.isDestroyed() ? win : null;
}

function showBox(options: Electron.MessageBoxOptions): void {
  const win = activeWindow();
  if (win) void dialog.showMessageBox(win, options);
  else void dialog.showMessageBox(options);
}

/** 上次成功检查的时间戳（毫秒）；无记录返回 0 */
async function lastCheckTime(): Promise<number> {
  try {
    const raw = await fsp.readFile(join(app.getPath('userData'), LAST_CHECK_FILE), 'utf-8');
    const value = JSON.parse(raw) as { checkedAt?: unknown };
    return typeof value.checkedAt === 'number' ? value.checkedAt : 0;
  } catch {
    return 0;
  }
}

/** 记录一次成功检查（静默失败：缓存不可用不影响功能） */
async function markChecked(): Promise<void> {
  try {
    await fsp.writeFile(
      join(app.getPath('userData'), LAST_CHECK_FILE),
      JSON.stringify({ checkedAt: Date.now() }),
      'utf-8'
    );
  } catch {
    // 忽略
  }
}

function notesText(notes: unknown): string {
  if (Array.isArray(notes)) {
    return notes
      .map((n) => (typeof n === 'object' && n ? String((n as { note?: unknown }).note ?? '') : ''))
      .join('\n');
  }
  return String(notes ?? '');
}

/** 注册更新事件（checkForUpdates 首次调用时执行一次） */
function registerUpdaterEvents(): void {
  if (eventsRegistered) return;
  eventsRegistered = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    void markChecked();
    const win = activeWindow();
    if (!win) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'info',
      title: 'Typewren - 发现新版本',
      message: `发现新版本 v${info.version}`,
      detail: `当前版本: v${app.getVersion()}\n\n${notesText(info.releaseNotes)}`,
      buttons: ['下载更新', '稍后提醒'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (choice === 0) void autoUpdater.downloadUpdate();
  });

  autoUpdater.on('update-not-available', () => {
    void markChecked();
    if (!checkSilent) {
      showBox({
        type: 'info',
        title: 'Typewren',
        message: '当前已是最新版本',
        detail: `Typewren v${app.getVersion()}`,
        buttons: ['确定']
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    const win = activeWindow();
    if (!win) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'info',
      title: 'Typewren - 更新已就绪',
      message: `v${info.version} 已下载完成`,
      detail: '重启应用即可完成安装；选择稍后则退出时自动安装。',
      buttons: ['立即重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (choice === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (error) => {
    if (checkSilent) return;
    showBox({
      type: 'error',
      title: 'Typewren',
      message: '检查更新失败',
      detail: String(error?.message ?? error),
      buttons: ['确定']
    });
  });
}

/**
 * 检查更新。silent=true 为启动自动检查（受 24h 间隔限制，失败不弹框）；
 * 手动检查（菜单）总是执行，结果与错误都会弹框。
 */
export async function checkForUpdates(silent = false): Promise<void> {
  // 未打包环境（dev / e2e）无法走 electron-updater 的发布源，跳过
  if (!app.isPackaged) {
    if (!silent) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Typewren',
        message: '开发模式下不检查更新',
        detail: '安装正式版后可通过「帮助 → 检查更新」获取新版本。',
        buttons: ['确定']
      });
    }
    return;
  }

  if (silent && Date.now() - (await lastCheckTime()) < AUTO_CHECK_INTERVAL_MS) return;

  checkSilent = silent;
  registerUpdaterEvents();
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    // 检查本身抛错（网络异常等）：error 事件也会兜底提示；静默模式不打扰
    if (!silent) {
      showBox({
        type: 'error',
        title: 'Typewren',
        message: '检查更新失败',
        detail: String(error instanceof Error ? error.message : error),
        buttons: ['确定']
      });
    }
  }
}
