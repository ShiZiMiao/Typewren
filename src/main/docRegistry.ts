import { app, BrowserWindow } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { isMarkdownPath } from '../shared/ipc';
import { saveSession } from './session';

/* ============================================================
 * 窗口 ↔ 文档路径登记表：多窗口的"哪个窗口开着什么"单一来源。
 * 消费方：会话恢复（窗口集合快照）、最近文件（含系统级 jump list）、
 * 重复打开检测（同一路径已有窗口时询问）。
 * 菜单重建经 onRecentsChanged 回调注入（index.ts 接线），避免与 menu.ts 循环依赖。
 * ============================================================ */

const TEST_MODE = process.argv.includes('--test');
const MAX_RECENT = 12;

const docPaths = new WeakMap<BrowserWindow, string>();

let recentFiles: string[] = [];
let recentsChanged: (() => void) | null = null;
let sessionTimer: NodeJS.Timeout | null = null;
/** 退出已开始：before-quit 已落最终快照，防抖写入不得再覆盖（窗口关闭时序竞态） */
let quitting = false;

function recentFile(): string {
  return join(app.getPath('userData'), 'recent.json');
}

/** Windows 路径大小写不敏感：比较键归一化 */
function pathKey(p: string): string {
  const abs = resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

export function loadRecentFiles(): void {
  if (TEST_MODE) return;
  try {
    const parsed: unknown = JSON.parse(readFileSync(recentFile(), 'utf-8'));
    if (Array.isArray(parsed)) {
      recentFiles = parsed.filter(
        (p): p is string => typeof p === 'string' && isMarkdownPath(p) && existsSync(p)
      );
    }
  } catch {
    recentFiles = [];
  }
}

export function getRecentFiles(): string[] {
  return [...recentFiles];
}

export function onRecentsChanged(callback: () => void): void {
  recentsChanged = callback;
}

/** 渲染层同步"本窗口当前文档路径"（loadContent/saveAs 时随 refreshTitle 发出） */
export function setWindowDoc(win: BrowserWindow, path: string | null): void {
  if (path !== null && isMarkdownPath(path)) {
    docPaths.set(win, resolve(path));
    recordRecent(path);
  } else {
    docPaths.delete(win);
  }
  scheduleSessionSave();
}

export function getWindowDoc(win: BrowserWindow): string | null {
  return docPaths.get(win) ?? null;
}

/** 查找已打开指定文档的窗口（路径归一化后比较） */
export function findWindowByDoc(filePath: string): BrowserWindow | null {
  const key = pathKey(filePath);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const doc = docPaths.get(win);
    if (doc && pathKey(doc) === key) return win;
  }
  return null;
}

function currentOpenPaths(): string[] {
  const out: string[] = [];
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const doc = docPaths.get(win);
    if (doc) out.push(doc);
  }
  return out;
}

/** 会话快照防抖写盘（打开/关闭/切换文档都只合并成一次写） */
export function scheduleSessionSave(): void {
  if (TEST_MODE || quitting) return;
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    sessionTimer = null;
    saveSession(currentOpenPaths());
  }, 500);
}

/** 立即落盘会话（退出前冲刷防抖，防止下次启动恢复出已关闭的窗口集合） */
export function flushSessionSave(): void {
  quitting = true;
  if (sessionTimer) {
    clearTimeout(sessionTimer);
    sessionTimer = null;
  }
  saveSession(currentOpenPaths());
}

function recordRecent(filePath: string): void {
  if (TEST_MODE) return;
  const abs = resolve(filePath);
  const key = pathKey(abs);
  recentFiles = [abs, ...recentFiles.filter((p) => pathKey(p) !== key)].slice(0, MAX_RECENT);
  try {
    writeFileSync(recentFile(), JSON.stringify(recentFiles), 'utf-8');
  } catch {
    // 最近列表尽力而为
  }
  try {
    app.addRecentDocument(abs);
  } catch {
    // 非 Windows/macOS 或平台拒绝时忽略
  }
  recentsChanged?.();
}

export function clearRecentFiles(): void {
  if (TEST_MODE) return;
  recentFiles = [];
  try {
    writeFileSync(recentFile(), '[]', 'utf-8');
  } catch {
    // ignore
  }
  app.clearRecentDocuments();
  recentsChanged?.();
}
