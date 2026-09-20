import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { isMarkdownPath } from '../shared/ipc';

/* ============================================================
 * 会话恢复：持续记录"当前打开的文档路径集合"到 userData/session.json，
 * 下次启动（无命令行文件参数时）按原样重开各窗口。
 * 只在主进程使用；--test 模式整体禁用（测试绝不读写/污染会话）。
 * 同步 IO 仅保留两处：takeSession（启动单次 + 取后即删的原子语义）
 * 与 flushSessionSave（before-quit 退出前同步落盘，异步写可能来不及）。
 * ============================================================ */

const TEST_MODE = process.argv.includes('--test');

function sessionFile(): string {
  return join(app.getPath('userData'), 'session.json');
}

/** 持久化当前打开的文档路径（去重、只留 Markdown 路径；空集合清空文件）。
 * 防抖/窗口关闭等高频路径：异步写盘，不阻塞主进程。 */
export function saveSession(paths: (string | null)[]): void {
  if (TEST_MODE) return;
  const file = sessionFile();
  const unique = [...new Set(paths.filter((p): p is string => p !== null))];
  void (async () => {
    try {
      if (unique.length === 0) {
        // 保留原语义：文件已存在才清空，不存在则不创建
        if (existsSync(file)) await fsp.writeFile(file, '[]', 'utf-8');
        return;
      }
      await fsp.writeFile(file, JSON.stringify(unique), 'utf-8');
    } catch {
      // 会话是尽力而为的便利功能，失败不打扰
    }
  })();
}

/** 同步落盘会话（before-quit 用：退出前异步写可能来不及）。 */
export function saveSessionSync(paths: (string | null)[]): void {
  if (TEST_MODE) return;
  const file = sessionFile();
  const unique = [...new Set(paths.filter((p): p is string => p !== null))];
  try {
    if (unique.length === 0) {
      if (existsSync(file)) writeFileSync(file, '[]', 'utf-8');
      return;
    }
    writeFileSync(file, JSON.stringify(unique), 'utf-8');
  } catch {
    // 会话是尽力而为的便利功能，失败不打扰
  }
}

/** 读取并清空会话（取后即删，防止启动失败后重复恢复造成窗口翻倍）。
 * 同步读+同步清空保证原子性；仅在启动时调用一次，阻塞可忽略。 */
export function takeSession(): string[] {
  if (TEST_MODE) return [];
  const file = sessionFile();
  try {
    const raw = readFileSync(file, 'utf-8');
    writeFileSync(file, '[]', 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is string => typeof p === 'string' && isMarkdownPath(p) && existsSync(p)
    );
  } catch {
    return [];
  }
}
