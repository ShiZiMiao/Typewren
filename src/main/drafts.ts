import { app, ipcMain } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { isDraftSavePayload, type DraftRecord } from '../shared/ipc';

/* ============================================================
 * 崩溃恢复草稿：渲染层定时把脏文档快照写入 userData/drafts，
 * 正常保存 / 关闭 / 放弃更改时清除；启动后由首个窗口一次性领取。
 * --test 模式整体不注册（避免测试进程污染真实用户数据、避免恢复串台）。
 * ============================================================ */

/** 单个草稿内容上限，防止异常大文档刷爆磁盘 */
const MAX_DRAFT_LENGTH = 10 * 1024 * 1024;

function draftDir(): string {
  return join(app.getPath('userData'), 'drafts');
}

/** 以文档路径为键（未命名文档键为空串，互相覆盖只留最新） */
function draftKey(path: string): string {
  return (
    createHash('sha1')
      .update(path || 'untitled')
      .digest('hex') + '.json'
  );
}

export function registerDraftHandlers(): void {
  if (process.argv.includes('--test')) return;

  ipcMain.on('draft:save', (_event, payload: unknown) => {
    if (!isDraftSavePayload(payload) || payload.content.length > MAX_DRAFT_LENGTH) return;
    const record: DraftRecord = {
      path: payload.path,
      content: payload.content,
      savedAt: Date.now()
    };
    void (async () => {
      try {
        await fsp.mkdir(draftDir(), { recursive: true });
        await fsp.writeFile(
          join(draftDir(), draftKey(record.path)),
          JSON.stringify(record),
          'utf-8'
        );
      } catch {
        // 草稿是尽力而为的兜底，写失败不打扰用户
      }
    })();
  });

  ipcMain.on('draft:clear', (_event, path: unknown) => {
    if (typeof path !== 'string') return;
    void fsp.unlink(join(draftDir(), draftKey(path))).catch(() => {});
  });
}

/**
 * 读取并清空全部草稿（主进程启动规划恢复窗口时用）。
 * --test 下返回空：测试实例从不落草稿，也绝不消费开发机的真实草稿。
 */
export function consumeDrafts(): DraftRecord[] {
  if (process.argv.includes('--test')) return [];
  let names: string[];
  try {
    names = existsSync(draftDir()) ? readdirSync(draftDir()) : [];
  } catch {
    return [];
  }
  const drafts: DraftRecord[] = [];
  for (const name of names) {
    const filePath = join(draftDir(), name);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const record = JSON.parse(raw) as DraftRecord;
      if (typeof record.path === 'string' && typeof record.content === 'string') {
        drafts.push(record);
      }
    } catch {
      // 损坏的草稿直接丢弃
    }
    try {
      unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
  drafts.sort((a, b) => a.savedAt - b.savedAt);
  return drafts;
}
