import { app, dialog, BrowserWindow, ipcMain } from 'electron';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { autoUpdater, CancellationToken } from 'electron-updater';
// CancellationError 是 electron-updater 的内部依赖（builder-util-runtime）导出，
// 用于区分「用户取消」与「真实失败」（error 事件对取消不派发，Promise 却会拒绝）
import { CancellationError } from 'builder-util-runtime';

import type { UpdateDownloadState } from '../shared/ipc';

/* ============================================================
 * 更新检查：electron-updater（GitHub Releases 提供源）
 * - 自动检查 24h 间隔（userData 缓存上次成功时间），启动静默
 * - 手动检查（帮助 → 检查更新）不受间隔限制
 * - 发现新版：弹框确认 → 下载 → 完成后弹框「立即重启安装 / 稍后」
 * - 下载期间向渲染层推送进度（updater:download-state），提示卡展示
 *   并可取消；任务栏图标同步百分比进度
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

/** 下载状态机：idle（未下载）→ downloading（进行中）→ downloaded（已就绪待安装） */
type DownloadPhase = 'idle' | 'downloading' | 'downloaded';
let downloadPhase: DownloadPhase = 'idle';
/** 正在下载的目标版本（progress 推送与提示卡标题用） */
let downloadVersion = '';
/** 当前下载的取消令牌（cancel 时 cancel() 中止 electron-updater 下载流） */
let cancelToken: CancellationToken | null = null;
/** 用户是否已请求取消。真实错误与取消可能走同一条 Promise 拒绝路径，
 *  在下载 Promise finally 前保持 true，error 事件据此跳过弹框 */
let downloadCanceled = false;

function activeWindow(): BrowserWindow | null {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  return win && !win.isDestroyed() ? win : null;
}

function showBox(options: Electron.MessageBoxOptions): void {
  const win = activeWindow();
  if (win) void dialog.showMessageBox(win, options);
  else void dialog.showMessageBox(options);
}

/** 把下载状态推送给所有窗口的渲染进程 */
function notifyRenderer(state: UpdateDownloadState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('updater:download-state', state);
  }
}

/** 任务栏图标进度；null 清除（Windows 任务栏 / macOS Dock 通用） */
function setTaskbarProgress(percent: number | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.setProgressBar(percent === null ? -1 : percent / 100);
  }
}

/** 终止当前下载并把状态机复位（取消或出错后共用）。
 *  downloadCanceled 不在这里清除：Promise finally 结束时才清，error 事件需凭它识别取消竞态 */
function resetDownload(): void {
  downloadPhase = 'idle';
  downloadVersion = '';
  cancelToken = null;
  setTaskbarProgress(null);
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

/** 把 electron-updater 的原始错误转成对用户简洁的提示 */
function errorDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // 最常见：发布时漏传 latest.yml（GitHub 对任何 404 都提示检查 token，易误导用户）
  if (/Cannot find latest\.yml in the latest release artifacts/.test(raw)) {
    return '更新源缺少 latest.yml（该版本发布不完整）。\n请确认发布时已随安装包上传 latest.yml 文件。';
  }
  // HttpError 消息附带完整 HTTP 响应头与请求转储（"method: ..." / Headers: {...}），
  // 对用户无意义，只保留错误主体首段
  const cut = raw.search(/[\r\n]+"?method: GET|[\r\n]+Headers:/);
  const brief = cut >= 0 ? raw.slice(0, cut) : raw;
  return brief.trim() || '未知错误';
}

/** 让用户确认立即重启安装（更新已就绪时，手动再次「检查更新」也会走到这里） */
function promptInstall(version: string): void {
  const win = activeWindow();
  if (!win) return;
  const choice = dialog.showMessageBoxSync(win, {
    type: 'info',
    title: 'Typewren - 更新已就绪',
    message: `v${version} 已下载完成`,
    detail: '重启应用即可完成安装；选择稍后则退出时自动安装。',
    buttons: ['立即重启安装', '稍后'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  if (choice === 0) autoUpdater.quitAndInstall();
}

/** 开始下载（用户从「发现新版本」弹框确认后调用） */
function startDownload(version: string): void {
  downloadPhase = 'downloading';
  downloadVersion = version;
  downloadCanceled = false;
  cancelToken = new CancellationToken();
  setTaskbarProgress(0);
  notifyRenderer({ phase: 'starting', version });

  void autoUpdater
    .downloadUpdate(cancelToken)
    .catch((error) => {
      // 真实错误由 'error' 事件兜底（它先于本 catch 派发，弹框只出一次）；
      // 用户取消（CancellationError）不算失败；这里仅防止 unhandled rejection
      if (error instanceof CancellationError || downloadCanceled) return;
      console.error('[updater] downloadUpdate failed:', error);
    })
    .finally(() => {
      downloadCanceled = false;
    });
}

/** 注册更新事件（checkForUpdates 首次调用时执行一次） */
function registerUpdaterEvents(): void {
  if (eventsRegistered) return;
  eventsRegistered = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    void markChecked();
    // 兜底：即便状态机判断漏了，已在下载/已下载时也不再弹「发现新版本」
    if (downloadPhase !== 'idle') return;
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
    if (choice === 0) startDownload(info.version);
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

  autoUpdater.on('download-progress', (progress) => {
    if (downloadPhase !== 'downloading') return;
    if (progress.total > 0) setTaskbarProgress(progress.percent);
    notifyRenderer({
      phase: 'progress',
      version: downloadVersion,
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (downloadPhase !== 'downloading') return;
    downloadPhase = 'downloaded';
    cancelToken = null;
    downloadCanceled = false;
    setTaskbarProgress(null);
    notifyRenderer({ phase: 'done', version: info.version });
    promptInstall(info.version);
  });

  autoUpdater.on('error', (error) => {
    // 用户主动取消：error 事件不派发 CancellationError，但有的路径会落到这里，
    // 状态已被 cancel IPC 复位，直接忽略
    if (downloadCanceled) return;
    const wasDownloading = downloadPhase === 'downloading';
    if (wasDownloading) {
      resetDownload();
      notifyRenderer({ phase: 'error', message: errorDetail(error) });
      showBox({
        type: 'error',
        title: 'Typewren',
        message: '更新下载失败',
        detail: errorDetail(error),
        buttons: ['确定']
      });
    } else if (!checkSilent) {
      showBox({
        type: 'error',
        title: 'Typewren',
        message: '检查更新失败',
        detail: errorDetail(error),
        buttons: ['确定']
      });
    }
  });
}

/**
 * 检查更新。silent=true 为启动自动检查（受 24h 间隔限制，失败不弹框）；
 * 手动检查（菜单）总是执行，结果与错误都会弹框。
 * 下载中 / 已下载未安装时，手动检查不再重复发起检查与下载，
 * 改为告知当前进度或直接提示重启安装（解决「多次点击多次下载」）。
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

  if (!silent) {
    if (downloadPhase === 'downloading') {
      showBox({
        type: 'info',
        title: 'Typewren',
        message: '更新正在下载中',
        detail: `v${downloadVersion} 正在后台下载，下载完成后会提示安装。`,
        buttons: ['知道了']
      });
      return;
    }
    if (downloadPhase === 'downloaded') {
      promptInstall(downloadVersion);
      return;
    }
  } else if (downloadPhase !== 'idle') {
    // 启动静默检查撞上正在下载/已就绪：不重复打扰
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
        detail: errorDetail(error),
        buttons: ['确定']
      });
    }
  }
}

/** 注册更新相关 IPC：渲染层「取消下载」按钮 */
export function registerUpdaterIpc(): void {
  ipcMain.on('updater:cancel-download', () => {
    if (downloadPhase !== 'downloading') return;
    downloadCanceled = true;
    cancelToken?.cancel();
    resetDownload();
    notifyRenderer({ phase: 'canceled' });
  });
}
