import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isMarkdownPath } from '../shared/ipc';

/* ============================================================
 * 会话恢复：持续记录"当前打开的文档路径集合"到 userData/session.json，
 * 下次启动（无命令行文件参数时）按原样重开各窗口。
 * 只在主进程使用；--test 模式整体禁用（测试绝不读写/污染会话）。
 * ============================================================ */

const TEST_MODE = process.argv.includes('--test');

function sessionFile(): string {
  return join(app.getPath('userData'), 'session.json');
}

/** 持久化当前打开的文档路径（去重、只留 Markdown 路径；空集合删除文件） */
export function saveSession(paths: (string | null)[]): void {
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

/** 读取并清空会话（取后即删，防止启动失败后重复恢复造成窗口翻倍） */
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
