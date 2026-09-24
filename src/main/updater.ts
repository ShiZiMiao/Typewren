import { app, dialog, shell, BrowserWindow, ipcMain } from 'electron';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { autoUpdater, CancellationToken } from 'electron-updater';

import type { UpdateDownloadState } from '../shared/ipc';

/* ============================================================
 * 更新检查：electron-updater（GitHub Releases 提供源）
 * - 自动检查 24h 间隔（userData 缓存上次成功时间），启动静默
 * - 手动检查（帮助 → 检查更新）不受间隔限制
 * - 发现新版：弹框确认 → 下载 → 完成后弹框「立即重启安装 / 稍后」
 * - 下载期间向渲染层推送进度（updater:download-state），提示卡展示
 *   并可取消；任务栏图标同步百分比进度
 * - 打包版才检查（unpackaged 即 dev/测试，自动返回）
 * - 检查结果/错误的弹框口径由**调用链参数** silent 决定（随闭包走），
 *   不再用全局 checkSilent——手动与静默检查并发时全局单值会串扰弹错框
 * 注意：未配置代码签名证书时，Windows 安装器会有 SmartScreen 提示，
 * 属签名证书问题，与更新器本身无关。
 * ============================================================ */

/** 自动检查间隔（避免每次启动都打更新源） */
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 上次检查时间戳缓存文件（userData 下） */
const LAST_CHECK_FILE = 'last-update-check.json';
/** 发布页基址（「查看更新日志」按钮打开 GitHub 渲染版式的完整日志） */
const RELEASE_TAG_BASE = 'https://github.com/ShiZiMiao/Typewren/releases/tag';
/** 「发现新版本」弹框里更新说明的最大行数（完整版在发布页） */
const NOTES_MAX_LINES = 24;

/** 事件只注册一次（防止重复订阅导致多弹框） */
let eventsRegistered = false;
/** 检查在途标志：autoUpdater.checkForUpdates 对并发调用复用同一 Promise，
 *  每个调用方各自 then 会把"发现新版本"弹两次——检查串行化，后来者直接返回 */
let checkInFlight = false;

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

/**
 * 用户取消下载的错误判定。
 * 坑（勿引 builder-util-runtime）：CancellationError 是 electron-updater 的传递依赖，
 * 直接从传递依赖 import 会在依赖树调整时断掉；且该类不设 name（Error 默认 'Error'），
 * 真实特征是 message 'cancelled'——name 匹配仅兼容可能的变体。
 */
function isCancellationError(error: unknown): boolean {
  return error instanceof Error && /^cancell?ed$/i.test(error.message.trim());
}

/** 上次成功检查的时间戳（毫秒）；无记录返回 0 */
async function lastCheckTime(): Promise<number> {
  try {
    const raw = await fsp.readFile(join(app.getPath('userData'), LAST_CHECK_FILE), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    // 显式判对象再取字段：JSON.parse('null' / '[]' / '5') 都不抛异常，
    // 靠 try/catch 兜底会把它们当合法记录读出 undefined
    if (typeof parsed !== 'object' || parsed === null) return 0;
    const checkedAt = (parsed as { checkedAt?: unknown }).checkedAt;
    return typeof checkedAt === 'number' ? checkedAt : 0;
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

/**
 * 发布说明 HTML → 弹框可用的纯文本（纯函数，供单测）。
 * 来源：GitHub releases.atom 的 `<content>` 是 **markdown 渲染后的 HTML**，
 * electron-updater 原样放进 releaseNotes——直接塞原生弹框会裸露 <h2>/<li> 等
 * 标签（用户实测截图）。转换规则：块级标签分行、`<li>` 转项目符号、行内标签
 * 去标记留内容；实体解码放在去标签**之后**（代码示例里的 `&lt;div&gt;` 要还原成
 * 字面量而不是被当标签剥掉）。
 */
export function htmlNotesToPlainText(html: string): string {
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(li|p|h[1-6]|ul|ol|div|tr|blockquote)>/gi, '\n')
    .replace(/<(p|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);|&#(\d+);/gi, (_m, hex: string, dec: string) => {
      try {
        return String.fromCodePoint(parseInt(hex ?? dec, hex ? 16 : 10));
      } catch {
        return '';
      }
    })
    .replace(/&amp;/g, '&');
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 归一并截断 electron-updater 的 releaseNotes（数组/字符串、HTML/纯文本都收） */
export function formatReleaseNotes(notes: unknown): string {
  const raw = Array.isArray(notes)
    ? notes
        .map((n) => (typeof n === 'object' && n ? String((n as { note?: unknown }).note ?? '') : ''))
        .join('\n\n')
    : String(notes ?? '');
  const text = htmlNotesToPlainText(raw);
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length > NOTES_MAX_LINES) {
    return `${lines.slice(0, NOTES_MAX_LINES).join('\n')}\n……（完整更新日志见发布页）`;
  }
  return text;
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
  // 异步对话框：showMessageBoxSync 会阻塞主进程事件循环，
  // 多窗口下其它窗口的 IPC 一起卡死（同 AGENTS 决策 #15 的关闭保护坑）
  void (async () => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Typewren - 更新已就绪',
      message: `v${version} 已下载完成`,
      detail: '重启应用即可完成安装；选择稍后则退出时自动安装。',
      buttons: ['立即重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (response === 0) autoUpdater.quitAndInstall();
  })();
}

/** 开始下载（用户从「发现新版本」弹框确认后调用） */
function startDownload(version: string): void {
  downloadPhase = 'downloading';
  downloadVersion = version;
  downloadCanceled = false;
  cancelToken = new CancellationToken();
  // 恢复"退出时自动安装"：上次取消下载时被关掉（见 cancel IPC）
  autoUpdater.autoInstallOnAppQuit = true;
  setTaskbarProgress(0);
  notifyRenderer({ phase: 'starting', version });

  void autoUpdater
    .downloadUpdate(cancelToken)
    .catch((error) => {
      // 真实错误由 'error' 事件兜底（它先于本 catch 派发，弹框只出一次）；
      // 用户取消（CancellationError）不算失败；这里仅防止 unhandled rejection
      if (isCancellationError(error) || downloadCanceled) return;
      console.error('[updater] downloadUpdate failed:', error);
    })
    .finally(() => {
      downloadCanceled = false;
    });
}

/** 注册下载生命周期事件（checkForUpdates 首次调用时执行一次）。
 *  检查结果（发现新版/已最新/检查失败）不在事件里处理——事件闭包拿不到
 *  "本次检查是否静默"，一律改由 checkForUpdates 的调用链参数裁决 */
function registerUpdaterEvents(): void {
  if (eventsRegistered) return;
  eventsRegistered = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

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
    // 只处理下载期错误；检查期错误由 checkForUpdates 的 catch 按 silent 参数提示
    // （两处都弹会重复出框）
    if (downloadPhase !== 'downloading') return;
    resetDownload();
    notifyRenderer({ phase: 'error', message: errorDetail(error) });
    showBox({
      type: 'error',
      title: 'Typewren',
      message: '更新下载失败',
      detail: errorDetail(error),
      buttons: ['确定']
    });
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
  if (checkInFlight) return;
  checkInFlight = true;
  registerUpdaterEvents();
  try {
    const result = await autoUpdater.checkForUpdates();
    void markChecked();
    if (result?.isUpdateAvailable !== true) {
      if (!silent) {
        showBox({
          type: 'info',
          title: 'Typewren',
          message: '当前已是最新版本',
          detail: `Typewren v${app.getVersion()}`,
          buttons: ['确定']
        });
      }
      return;
    }
    // 兜底：即便状态机判断漏了，已在下载/已下载时也不再弹「发现新版本」
    if (downloadPhase !== 'idle') return;
    const win = activeWindow();
    if (!win) return;
    // 更新说明先归一成纯文本再进弹框（原生消息框不渲染 HTML/Markdown）。
    // 原生弹框只承载摘要；完整日志经「查看更新日志」开发布页看渲染版式
    const notes = formatReleaseNotes(result.updateInfo.releaseNotes);
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Typewren - 发现新版本',
      message: `发现新版本 v${result.updateInfo.version}`,
      detail: `当前版本: v${app.getVersion()}${notes ? `\n\n${notes}` : ''}`,
      buttons: ['下载更新', '查看更新日志', '稍后提醒'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });
    if (response === 0) {
      startDownload(result.updateInfo.version);
    } else if (response === 1) {
      // 开发布页后不自动下载（页面上也有安装包）；之后仍可经「检查更新」升级
      void shell.openExternal(`${RELEASE_TAG_BASE}/v${result.updateInfo.version}`);
    }
  } catch (error) {
    // 检查本身抛错（网络异常等）：静默模式不打扰；error 事件对检查期错误不再弹框
    if (!silent) {
      showBox({
        type: 'error',
        title: 'Typewren',
        message: '检查更新失败',
        detail: errorDetail(error),
        buttons: ['确定']
      });
    }
  } finally {
    checkInFlight = false;
  }
}

/** 注册更新相关 IPC：渲染层「取消下载」按钮 */
export function registerUpdaterIpc(): void {
  ipcMain.on('updater:cancel-download', () => {
    if (downloadPhase !== 'downloading') return;
    downloadCanceled = true;
    cancelToken?.cancel();
    // 取消与完成的竞态：下载可能恰在取消瞬间跑完，状态机挡住了完成提示，
    // 但 electron-updater 内部仍会随应用退出自动安装——取消成功必须关掉
    // autoInstallOnAppQuit（下次下载开始时恢复，见 startDownload）
    autoUpdater.autoInstallOnAppQuit = false;
    resetDownload();
    notifyRenderer({ phase: 'canceled' });
  });
}
