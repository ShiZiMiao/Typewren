import { test, expect, _electron as electron } from '@playwright/test';
import type { Page } from 'playwright';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OUT_MAIN,
  closeApp,
  installDialogStubs,
  setDialog,
  sendCommand,
  type AppHandle
} from './helpers';

/* ============================================================
 * 崩溃恢复草稿（drafts.ts + fileService 定时落盘）
 * 草稿写 userData 且关闭保护在 --test 下被跳过，故这些用例必须
 * 用不带 --test 的真实实例 + 每用例独立 --user-data-dir（绝不污染
 * 开发机真实数据）+ --draft-interval 缩短自动落盘间隔。
 * ============================================================ */

// 每次运行独立目录：避免上一轮被强杀的进程锁目录导致 EPERM
const RUN_ID = `${process.pid}-${Date.now()}`;
const WORK_DIR = join(tmpdir(), `typewren-draft-test-${RUN_ID}`);

async function launch(
  tag: string,
  opts: { dataDir?: string; fileArg?: string } = {}
): Promise<AppHandle> {
  const dataDir = opts.dataDir ?? join(WORK_DIR, `ud-${tag}`);
  const args = [OUT_MAIN, '--headless', `--user-data-dir=${dataDir}`, '--draft-interval=300'];
  if (opts.fileArg) args.push(opts.fileArg);
  const app = await electron.launch({ args });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForSelector('.ProseMirror', { timeout: 15000 });
  await window.waitForTimeout(300);
  const handle = { app, window };
  await installDialogStubs(handle, { discard: 1 });
  return handle;
}

/** 草稿目录当前文件数（目录尚未创建按 0） */
function countDrafts(draftsDir: string): number {
  try {
    return readdirSync(draftsDir).length;
  } catch {
    return 0;
  }
}

/**
 * 模拟崩溃：taskkill /F /T 杀整棵进程树并轮询等待 PID 消失
 * （Playwright 子进程的 kill() 在本机 Windows 上实测不生效）。
 */
async function crash(handle: AppHandle): Promise<void> {
  const pid = handle.app.process().pid;
  if (pid === undefined) throw new Error('electron 进程 pid 未知，无法模拟崩溃');
  execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      return;
    }
  }
  throw new Error(`electron pid ${pid} survived taskkill`);
}

async function typeInto(window: Page, text: string): Promise<void> {
  await window.locator('.ProseMirror').click();
  await window.keyboard.type(text);
}

test.beforeAll(() => {
  mkdirSync(WORK_DIR, { recursive: true });
});

test('脏文档崩溃后重启：草稿恢复到未保存状态', async () => {
  const first = await launch('crash');
  await typeInto(first.window, '崩溃前的内容');
  // 等多个自动落盘周期，确保草稿已写盘
  await first.window.waitForTimeout(1200);
  await crash(first);

  const second = await launch('crash');
  try {
    await expect(second.window.locator('.ProseMirror')).toContainText('崩溃前的内容', {
      timeout: 15000
    });
    // 恢复内容相对磁盘基线呈未保存状态（标题栏脏标记）
    await expect(second.window.locator('#titlebar-title')).toContainText('●');
  } finally {
    // 关闭保护弹框（桩应答"不保存"）把恢复出的脏文档关掉
    await closeApp(second);
  }
});

test('正常保存后崩溃：无草稿复活（会话按磁盘内容干净恢复）', async () => {
  const savePath = join(WORK_DIR, 'saved.md');
  const first = await launch('saved');
  await typeInto(first.window, '已保存的内容');
  await setDialog(first, { saveAs: savePath });
  await sendCommand(first, 'save'); // 无路径 → 走另存为
  await expect.poll(() => existsSync(savePath)).toBe(true);
  expect(readFileSync(savePath, 'utf-8')).toContain('已保存的内容');
  await first.window.waitForTimeout(800); // 让清草稿与防抖会话写都送达
  await crash(first);

  const second = await launch('saved');
  try {
    await second.window.waitForSelector('.ProseMirror', { timeout: 15000 });
    // 会话恢复会按磁盘内容重开该文件：内容在，但绝不允许出现脏标记
    // （若保存后草稿未清干净，restoreDraft 会让文档呈未保存态）
    await expect(second.window.locator('.ProseMirror')).toContainText('已保存的内容', {
      timeout: 15000
    });
    await expect(second.window.locator('#titlebar-title')).not.toContainText('●');
  } finally {
    await closeApp(second);
  }
});

test('关闭保护选"不保存"：草稿被清理，重启不复活', async () => {
  const first = await launch('discard');
  await typeInto(first.window, '要丢弃的内容');
  await first.window.waitForTimeout(1000);

  await setDialog(first, { discard: 1 });
  const closed = first.window.waitForEvent('close', { timeout: 10000 }).then(() => true);
  await first.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close();
  });
  expect(await closed).toBe(true);
  await first.app.close().catch(() => {});

  const second = await launch('discard');
  try {
    await second.window.waitForSelector('.ProseMirror', { timeout: 15000 });
    const text = await second.window.locator('.ProseMirror').innerText();
    expect(text).not.toContain('要丢弃的内容');
    await expect(second.window.locator('#titlebar-title')).not.toContainText('●');
  } finally {
    await closeApp(second);
  }
});

test('带命令行文件启动：崩溃草稿与会话原样保留（启动规划禁止破坏性读取）', async () => {
  const docA = join(WORK_DIR, 'cli-keep-a.md');
  const docB = join(WORK_DIR, 'cli-keep-b.md');
  writeFileSync(docA, '# 文档甲\n\n', 'utf-8');
  writeFileSync(docB, '# 文档乙\n\n', 'utf-8');
  const dataDir = join(WORK_DIR, 'ud-cli-keep');
  const draftsDir = join(dataDir, 'drafts');
  const sessionFile = join(dataDir, 'session.json');

  // 阶段 1：带参打开 A，编辑变脏并等草稿落盘，再模拟崩溃（草稿/会话留在盘上）
  const first = await launch('cli-keep', { dataDir, fileArg: docA });
  await typeInto(first.window, '崩溃前的草稿内容');
  await expect.poll(() => countDrafts(draftsDir), { timeout: 8000 }).toBe(1);
  await expect
    .poll(
      () => {
        try {
          return readFileSync(sessionFile, 'utf-8');
        } catch {
          return '';
        }
      },
      { timeout: 5000 }
    )
    .toContain('cli-keep-a.md');
  await crash(first);
  expect(countDrafts(draftsDir)).toBe(1);

  // 阶段 2：带**另一个**命令行文件启动。consumeDrafts/takeSession 是读后即删的
  // 破坏性读取——启动规划若把它们当实参无条件求值后被 cliFile 短路丢弃，
  // 草稿会被永久吞掉、会话被清空。外置采样盯住会话文件：takeSession 的清空
  // 动作会把文件写成 '[]'（正常会话跟踪 500ms 防抖后写的是新窗口集合，不是 '[]'）
  const samples: string[] = [];
  const sampler = setInterval(() => {
    try {
      samples.push(readFileSync(sessionFile, 'utf-8'));
    } catch {
      // 文件尚未写出
    }
  }, 25);
  let second: AppHandle | null = null;
  try {
    second = await launch('cli-keep', { dataDir, fileArg: docB });
    await second.window.waitForSelector('.ProseMirror', { timeout: 15000 });
    expect(countDrafts(draftsDir)).toBe(1);
  } finally {
    clearInterval(sampler);
  }
  expect(samples.filter((s) => s.replace(/\s/g, '') === '[]')).toHaveLength(0);

  // 阶段 3：关掉阶段 2 的窗口后无参重启——被"原样保留"的草稿必须还能恢复出来
  // （数据安全的终极断言：不是没被删过就算赢）
  await closeApp(second!);
  const third = await launch('cli-keep', { dataDir });
  try {
    await expect(third.window.locator('.ProseMirror')).toContainText('崩溃前的草稿内容', {
      timeout: 15000
    });
  } finally {
    await setDialog(third, { discard: 1 });
    await closeApp(third);
  }
});

test('未命名草稿恢复后可保存、草稿可清除（空路径不得被 resolve 成 cwd）', async () => {
  const dataDir = join(WORK_DIR, 'ud-untitled');
  const draftsDir = join(dataDir, 'drafts');

  // 阶段 1：未命名文档写脏 → 草稿（路径键为空串）→ 模拟崩溃
  const first = await launch('untitled', { dataDir });
  await typeInto(first.window, '未命名文档的内容');
  await expect.poll(() => countDrafts(draftsDir), { timeout: 8000 }).toBe(1);
  await crash(first);

  // 阶段 2：恢复出未命名草稿，然后保存（另存为）
  const second = await launch('untitled', { dataDir });
  try {
    await expect(second.window.locator('.ProseMirror')).toContainText('未命名文档的内容', {
      timeout: 15000
    });
    await expect(second.window.locator('#titlebar-title')).toContainText('●');

    // 坑（回归点）：take-pending-open 曾把空路径 resolve('') 成 process.cwd()
    // 绑成文档路径——保存直接写目录（EISDIR）失败，clearDraft 的键也永远对不上、
    // 草稿残留后崩溃复活。空路径必须原样透传（未命名语义）
    const savePath = join(WORK_DIR, 'untitled-saved.md');
    await setDialog(second, { saveAs: savePath });
    await sendCommand(second, 'save');
    await expect.poll(() => existsSync(savePath), { timeout: 8000 }).toBe(true);
    expect(readFileSync(savePath, 'utf-8')).toContain('未命名文档的内容');
    // 保存成功后草稿必须被清除（clearDraft 按本窗口 sender 键计算，
    // 须与恢复时 re-key 落盘的键一致）
    await expect.poll(() => countDrafts(draftsDir), { timeout: 8000 }).toBe(0);
  } finally {
    await closeApp(second);
  }
});
