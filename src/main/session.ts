import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { isOpenablePath } from '../shared/ipc';
import { isTestMode } from './runMode';

/* ============================================================
 * 会话恢复：持续记录"当前打开的文档路径集合"到 userData/session.json，
 * 下次启动（无命令行文件参数时）按原样重开各窗口。
 * 只在主进程使用；--test 模式整体禁用（测试绝不读写/污染会话）。
 * 同步 IO 仅保留两处：takeSession（启动单次 + 取后即删的原子语义）
 * 与 flushSessionSave（before-quit 退出前同步落盘，异步写可能来不及）。
 * ============================================================ */

function sessionFile(): string {
  return join(app.getPath('userData'), 'session.json');
}

/** 序列化窗口路径集合（去重；null 丢弃） */
function snapshotOf(paths: (string | null)[]): string {
  return JSON.stringify([...new Set(paths.filter((p): p is string => p !== null))]);
}

/**
 * 写盘串行化 + "只写最新"：
 * - 所有异步写走同一条链（prev.then(write)），链内启动前若已被更新请求取代则跳过，
 *   杜绝 500ms 防抖的旧快照晚到覆盖新内容（旧覆新）。
 * - before-quit 的同步最终快照（saveSessionSync）推进 stamp 并直接落盘；若此刻
 *   恰有异步写在途，它 await 返回后发现 stamp 已变会用最新快照追写一次（幂等双写）
 *   ——否则"在途旧写晚于同步最终快照落盘"会让退出后的会话回到旧窗口集合。
 */
let writeChain: Promise<void> = Promise.resolve();
let stamp = 0;
let latestData = '[]';

function enqueueSave(paths: (string | null)[]): void {
  const data = snapshotOf(paths);
  latestData = data;
  const mine = ++stamp;
  const file = sessionFile();
  writeChain = writeChain.then(async () => {
    if (mine !== stamp) return;
    try {
      if (data === '[]') {
        // 保留原语义：空集合只清空已存在的文件，不存在则不创建
        if (existsSync(file)) await fsp.writeFile(file, data, 'utf-8');
      } else {
        await fsp.writeFile(file, data, 'utf-8');
      }
    } catch {
      // 会话是尽力而为的便利功能，失败不打扰
    }
    if (mine !== stamp) {
      // 同步最终快照在我写盘期间落了 → 我这次是旧覆新，用最新快照追写一次
      try {
        await fsp.writeFile(file, latestData, 'utf-8');
      } catch {
        // ignore
      }
    }
  });
}

/** 持久化当前打开的文档路径（防抖/窗口关闭等高频路径：异步写盘，不阻塞主进程）。 */
export function saveSession(paths: (string | null)[]): void {
  if (isTestMode()) return;
  enqueueSave(paths);
}

/** 同步落盘会话（before-quit 用：退出前异步写可能来不及）。 */
export function saveSessionSync(paths: (string | null)[]): void {
  if (isTestMode()) return;
  const file = sessionFile();
  const data = snapshotOf(paths);
  // 取代所有在途/排队的异步写（它们 stamp 已旧，最多再追写一次最新快照）
  latestData = data;
  ++stamp;
  try {
    if (data === '[]') {
      if (existsSync(file)) writeFileSync(file, data, 'utf-8');
      return;
    }
    writeFileSync(file, data, 'utf-8');
  } catch {
    // 会话是尽力而为的便利功能，失败不打扰
  }
}

/**
 * 读取并清空会话（取后即删，防止启动失败后重复恢复造成窗口翻倍）。
 * 同步读+同步清空保证原子性；仅在启动时调用一次，阻塞可忽略。
 * 只在确认要按会话规划窗口时才调用（带命令行文件启动时不得触碰，
 * 否则"双击打开任意 md"就把上次会话清成了空——index.ts 启动规划有回归）。
 */
export function takeSession(): string[] {
  if (isTestMode()) return [];
  const file = sessionFile();
  try {
    const raw = readFileSync(file, 'utf-8');
    writeFileSync(file, '[]', 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 可打开文档口径（Markdown + txt）与 win:set-path 登记侧一致
    return parsed.filter(
      (p): p is string => typeof p === 'string' && isOpenablePath(p) && existsSync(p)
    );
  } catch {
    return [];
  }
}
