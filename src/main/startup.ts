import { resolve } from 'node:path';

import type { DraftRecord } from '../shared/ipc';

/* ============================================================
 * 启动窗口规划：把"命令行指定文件 / 崩溃恢复草稿 / 上次会话"
 * 合并成一组待打开窗口（主进程在 whenReady 时统一创建）。
 * 优先级与去重规则集中在此，index.ts 只负责照单创建。
 * ============================================================ */

export interface StartupWindow {
  path: string;
  /** 随附内容 = 崩溃恢复草稿（不读磁盘） */
  content?: string;
  /** 恢复出的文档须呈未保存状态 */
  restore?: boolean;
}

/** Windows 路径大小写不敏感 */
function pathKey(p: string): string {
  const abs = resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * 规划启动时要打开的窗口集合：
 * 1. 有命令行文件 → 只开它（会话/草稿磁盘原样保留，下次启动照常恢复，不丢数据）；
 * 2. 否则草稿在前（含未保存修改），会话路径补后；同一路径草稿优先。
 */
export function planStartupWindows(
  cliFile: string | null,
  drafts: DraftRecord[],
  sessionPaths: string[]
): StartupWindow[] {
  if (cliFile) return [{ path: cliFile }];

  const plan: StartupWindow[] = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    const key = pathKey(draft.path);
    if (seen.has(key)) continue;
    seen.add(key);
    plan.push({ path: draft.path, content: draft.content, restore: true });
  }
  for (const p of sessionPaths) {
    const key = pathKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    plan.push({ path: p });
  }
  return plan;
}
