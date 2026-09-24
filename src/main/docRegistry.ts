import { app, BrowserWindow } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join, resolve } from 'node:path';

import { isOpenablePath } from '../shared/ipc';
import { pathKey } from '../shared/pathKey';
import { isTestMode } from './runMode';
import { saveSession, saveSessionSync } from './session';

/* ============================================================
 * 窗口 ↔ 文档路径登记表：多窗口的"哪个窗口开着什么"单一来源。
 * 消费方：会话恢复（窗口集合快照）、最近文件（含系统级 jump list）、
 * 重复打开检测（同一路径已有窗口时询问）。
 * 菜单重建经 onRecentsChanged 回调注入（index.ts 接线），避免与 menu.ts 循环依赖。
 * ============================================================ */

const MAX_RECENT = 12;

const docPaths = new WeakMap<BrowserWindow, string>();

let recentFiles: string[] = [];
let recentsChanged: (() => void) | null = null;
let sessionTimer: NodeJS.Timeout | null = null;
/** 退出已开始：before-quit 已落最终快照，防抖写入不得再覆盖（窗口关闭时序竞态）。
 *  但退出可能被关闭保护"取消"中止——那时必须 resumeSessionSaves 复位，
 *  否则防抖存盘在剩余运行期永久失效（窗口开关不再记录会话）。 */
let quitting = false;
/** 最近文件写盘串行链（防快速连续登记时旧列表晚到覆盖新列表） */
let recentWriteChain: Promise<void> = Promise.resolve();

function recentFile(): string {
  return join(app.getPath('userData'), 'recent.json');
}

export function loadRecentFiles(): void {
  if (isTestMode()) return;
  try {
    const parsed: unknown = JSON.parse(readFileSync(recentFile(), 'utf-8'));
    if (Array.isArray(parsed)) {
      // 可打开文档口径（Markdown + txt）与 win:set-path 登记侧一致
      recentFiles = parsed.filter(
        (p): p is string => typeof p === 'string' && isOpenablePath(p) && existsSync(p)
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

/**
 * 渲染层同步"本窗口当前文档路径"（loadContent/saveAs 时随 refreshTitle 发出）。
 * recordRecent: false 只登记不进最近文件（启动规划的预登记用——会话恢复会在
 * 启动瞬间按规划顺序把"最近使用"重排成启动顺序，MRU 失真；最近文件推迟到
 * file:take-pending-open 领取成功后按 recordRecentFile 单点登记）。
 * 同路径重复上报（refreshTitle 节流后每次都会发）不再重排 MRU——只在
 * 文档路径真正变化（打开/另存为）时记录。
 */
export function setWindowDoc(
  win: BrowserWindow,
  path: string | null,
  opts?: { recordRecent?: boolean }
): void {
  if (path !== null && isOpenablePath(path)) {
    const abs = resolve(path);
    const previous = docPaths.get(win);
    docPaths.set(win, abs);
    if (opts?.recordRecent !== false && previous !== abs) {
      recordRecentFile(abs);
    }
  } else {
    docPaths.delete(win);
  }
  scheduleSessionSave();
}

/** 最近文件登记单点（file:take-pending-open 领取成功后调用；打开/另存为经 setWindowDoc） */
export function recordRecentFile(filePath: string): void {
  recordRecent(filePath);
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
  if (isTestMode() || quitting) return;
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    sessionTimer = null;
    saveSession(currentOpenPaths());
  }, 500);
}

/**
 * 立即落盘会话（退出前冲刷防抖，防止下次启动恢复出已关闭的窗口集合）。
 * 置 quitting 拦掉迟到的防抖写（退出过程中窗口逐个关闭会触发 schedule，
 * 覆盖掉"带窗退出恢复全部窗口"的最终快照）；退出若被关闭保护取消，
 * 由 resumeSessionSaves 复位（见函数注释）。
 */
export function flushSessionSave(): void {
  quitting = true;
  if (sessionTimer) {
    clearTimeout(sessionTimer);
    sessionTimer = null;
  }
  // before-quit 用同步落盘：异步写可能赶不上进程退出
  saveSessionSync(currentOpenPaths());
}

/**
 * 退出被中止（关闭保护选"取消"/保存流程中止）后恢复会话防抖存盘。
 * 不复位的话 quitting=true 会让剩余运行期内一切会话更新静默丢失。
 */
export function resumeSessionSaves(): void {
  quitting = false;
}

function recordRecent(filePath: string): void {
  if (isTestMode()) return;
  const abs = resolve(filePath);
  const key = pathKey(abs);
  recentFiles = [abs, ...recentFiles.filter((p) => pathKey(p) !== key)].slice(0, MAX_RECENT);
  const snapshot = JSON.stringify(recentFiles);
  recentWriteChain = recentWriteChain.then(() =>
    fsp.writeFile(recentFile(), snapshot, 'utf-8').catch(() => {
      // 最近列表尽力而为
    })
  );
  try {
    app.addRecentDocument(abs);
  } catch {
    // 非 Windows/macOS 或平台拒绝时忽略
  }
  recentsChanged?.();
}

export function clearRecentFiles(): void {
  if (isTestMode()) return;
  recentFiles = [];
  recentWriteChain = recentWriteChain.then(() =>
    fsp.writeFile(recentFile(), '[]', 'utf-8').catch(() => {
      // ignore
    })
  );
  app.clearRecentDocuments();
  recentsChanged?.();
}
