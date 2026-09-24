import { app, ipcMain } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { isDraftSavePayload, type DraftRecord } from '../shared/ipc';
import { isTestMode } from './runMode';

/* ============================================================
 * 崩溃恢复草稿：渲染层定时把脏文档快照写入 userData/drafts，
 * 正常保存 / 关闭 / 放弃更改时清除；启动后由首个窗口一次性领取。
 * --test 模式整体不注册（避免测试进程污染真实用户数据、避免恢复串台）。
 * ============================================================ */

/** 单个草稿内容上限，防止异常大文档刷爆磁盘 */
const MAX_DRAFT_LENGTH = 10 * 1024 * 1024;

/** 草稿写盘串行链：定时快照间隔可短至测试用 300ms，串行防"旧覆新" */
let writeChain: Promise<void> = Promise.resolve();

function draftDir(): string {
  return join(app.getPath('userData'), 'drafts');
}

/**
 * 草稿文件键 = sha1(`${senderWebContentsId}:${path}`)。
 * 坑：旧实现只按文档路径散列（未命名文档统一 sha1('untitled')），多窗口各自的
 * 未命名草稿共用一个文件互相覆盖（后写胜出，另一窗口的崩溃恢复内容丢失）。
 * 带上 sender id 后各窗口一份；draft:save / draft:clear 用同一 sender 计算键，
 * 渲染层契约（payload 只有 path/content）不变，clearDraft 仍能精确清除本窗口草稿。
 * 副作用是天然挡住"误删未领取草稿"：其它窗口/未领取草稿的键与本窗口算出来的
 * 键不同，markBaseline 的清草稿逻辑够不着（draftsTaken 闸门仍保留，勿撤）。
 */
function draftKey(senderId: number, path: string): string {
  return (
    createHash('sha1')
      .update(`${senderId}:${path}`)
      .digest('hex') + '.json'
  );
}

function enqueueWrite(task: () => Promise<void>): void {
  writeChain = writeChain.then(task);
}

async function writeDraftFile(senderId: number, record: DraftRecord): Promise<void> {
  try {
    await fsp.mkdir(draftDir(), { recursive: true });
    await fsp.writeFile(join(draftDir(), draftKey(senderId, record.path)), JSON.stringify(record), 'utf-8');
  } catch {
    // 草稿是尽力而为的兜底，写失败不打扰用户
  }
}

export function registerDraftHandlers(): void {
  if (isTestMode()) return;

  ipcMain.on('draft:save', (event, payload: unknown) => {
    if (!isDraftSavePayload(payload) || payload.content.length > MAX_DRAFT_LENGTH) return;
    const record: DraftRecord = {
      path: payload.path,
      content: payload.content,
      savedAt: Date.now()
    };
    const senderId = event.sender.id;
    enqueueWrite(() => writeDraftFile(senderId, record));
  });

  ipcMain.on('draft:clear', (event, path: unknown) => {
    if (typeof path !== 'string') return;
    const senderId = event.sender.id;
    // 与写共用同一条串行链：clear 若跑在 adopt/save 的在途写之前，
    // 写晚到会让"已清除"的草稿复活（保存后崩溃又恢复出旧内容）
    enqueueWrite(async () => {
      try {
        await fsp.unlink(join(draftDir(), draftKey(senderId, path)));
      } catch {
        // 文件本就不存在（未落过草稿/已清）即成功
      }
    });
  });
}

/**
 * 把领取到的崩溃恢复草稿落到本窗口 sender 的键上（re-key）。
 * consumeDrafts 取后即删（防启动失败重复恢复，见 AGENTS #16），所以这里不是
 * 文件改名而是按新键重写一份：此后渲染层定时快照（draft:save）与清理
 * （draft:clear）都按本窗口 sender 的键走，与此处落下的文件天然对齐——
 * 否则渲染层 clearDraft 算出的键对不上旧键文件，草稿永远残留、崩溃后复活。
 * 内容可能很大，走串行链（与 draft:save 共用，防旧覆新）。
 */
export function adoptDraft(senderId: number, path: string, content: string): void {
  const record: DraftRecord = { path, content, savedAt: Date.now() };
  enqueueWrite(() => writeDraftFile(senderId, record));
}

/**
 * 读取并清空全部草稿（主进程启动规划恢复窗口时用）。
 * --test 下返回空：测试实例从不落草稿，也绝不消费开发机的真实草稿。
 * 只在确认要按草稿规划窗口时才调用——它是破坏性读取（读后即删），
 * 调用方把结果丢弃 = 永久吞掉全部崩溃草稿（index.ts 启动规划有回归）。
 */
export function consumeDrafts(): DraftRecord[] {
  if (isTestMode()) return [];
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
      if (
        typeof record.path === 'string' &&
        typeof record.content === 'string' &&
        typeof record.savedAt === 'number'
      ) {
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
