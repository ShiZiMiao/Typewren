import { app, BrowserWindow, ipcMain, nativeTheme, session } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_SETTINGS, sanitizeSettings, type AppSettings } from '../shared/settings';

/* ============================================================
 * 应用设置（主进程侧）：
 * - userData/settings.json 读写（读取仅启动单次用同步；写入异步不阻塞主进程）
 * - settings:get / settings:set IPC；set 后立即应用副作用并广播全部窗口
 * - 副作用：nativeTheme.themeSource（标题栏/滚动条原生配色）、
 *   session.setSpellCheckerEnabled（红波浪线检测域）
 * 渲染层的设置状态以 settings:updated 广播为时钟（仿 nativeTheme 时序）。
 * ============================================================ */

/** 写盘防抖：设置对话框逐击键发 set（每击都落盘太吵），合并成最后一次。
 *  广播与副作用保持即时，只有落盘被合并。 */
const SAVE_DEBOUNCE_MS = 300;

let cache: AppSettings | null = null;
let saveTimer: NodeJS.Timeout | null = null;
/** 写盘串行链（防快速连改时上一次写还在途、旧值晚到覆盖） */
let writeChain: Promise<void> = Promise.resolve();

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json');
}

/** 读取设置（进程内缓存；文件损坏/缺失时回落默认值） */
export function loadSettings(): AppSettings {
  if (cache) return cache;
  try {
    const raw = readFileSync(settingsFile(), 'utf-8');
    cache = sanitizeSettings(JSON.parse(raw) as unknown);
  } catch {
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache;
}

/** 更新进程内缓存并（防抖）落盘 */
export function saveSettings(next: AppSettings): void {
  cache = next;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    enqueueWrite();
  }, SAVE_DEBOUNCE_MS);
}

/** 串行落盘：写的内容取执行时刻的缓存（永远最新），旧写不可能覆新 */
function enqueueWrite(): void {
  writeChain = writeChain.then(() => {
    const snapshot = cache;
    if (!snapshot) return;
    return fsp
      .writeFile(settingsFile(), JSON.stringify(snapshot, null, 2), 'utf-8')
      .catch(() => {
        // 设置是偏好功能，写失败不打扰（下次启动回落上次成功值）
      });
  });
}

/** 立即落盘（before-quit 用：防抖定时器可能赶不上退出；同步写） */
export function flushSettings(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const snapshot = cache;
  if (!snapshot) return;
  try {
    writeFileSync(settingsFile(), JSON.stringify(snapshot, null, 2), 'utf-8');
  } catch {
    // ignore
  }
}

/** 应用设置的主进程侧副作用（主题 / 拼写检查会话域） */
export function applySettingsSideEffects(settings: AppSettings): void {
  nativeTheme.themeSource = settings.theme;
  try {
    session.defaultSession.setSpellCheckerEnabled(settings.spellcheck);
  } catch {
    // 拼写检查词典初始化失败时静默
  }
}

export function registerSettingsIpc(): void {
  // 退出前冲刷防抖落盘（改完设置立即退出的场景，300ms 定时器赶不上）
  app.on('before-quit', () => flushSettings());
  ipcMain.handle('settings:get', () => sanitizeSettings(loadSettings()));
  ipcMain.on('settings:set', (_event, raw: unknown) => {
    const next = sanitizeSettings(raw);
    saveSettings(next);
    applySettingsSideEffects(next);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('settings:updated', next);
    }
  });
}

/** 启动时应用已有设置（须在建窗前调用：窗口底色/拼写检查从一开始就正确） */
export function applyStartupSettings(): void {
  applySettingsSideEffects(loadSettings());
}
