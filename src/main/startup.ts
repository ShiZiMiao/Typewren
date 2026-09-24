import type { DraftRecord } from '../shared/ipc';
import { pathKey } from '../shared/pathKey';

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
  /** 领取成功后记入最近文件（仅用户主动打开：命令行/拖拽；会话与草稿恢复不算"使用"） */
  recent?: boolean;
}

/**
 * 规划启动时要打开的窗口集合：
 * 1. 有命令行文件 → 只开它（会话/草稿磁盘原样保留，下次启动照常恢复，不丢数据）；
 *    注意 consumeDrafts/takeSession 是破坏性读取（读后即删），index.ts 必须按需
 *    惰性取用——作为实参无条件求值后被 cliFile 短路丢弃 = 启动即吞掉全部崩溃草稿
 *    并清空会话（回归见 drafts.spec）。
 * 2. 否则草稿在前（含未保存修改），会话路径补后；同一路径草稿优先。
 */
export function planStartupWindows(
  cliFile: string | null,
  drafts: DraftRecord[],
  sessionPaths: string[]
): StartupWindow[] {
  if (cliFile) return [{ path: cliFile, recent: true }];

  const plan: StartupWindow[] = [];
  const seen = new Set<string>();
  // 未命名草稿（path=''）各自独立成窗：pathKey('') 会解析成 cwd，
  // 按路径去重会把多个未命名草稿误合并成一个（其一的内容直接丢失）
  let untitledSeq = 0;
  for (const draft of drafts) {
    const key = draft.path ? pathKey(draft.path) : `untitled:${untitledSeq++}`;
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
