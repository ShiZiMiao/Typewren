import { test, expect, _electron as electron } from '@playwright/test';
import type { Page } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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

async function launch(tag: string): Promise<AppHandle> {
  const dataDir = join(WORK_DIR, `ud-${tag}`);
  const app = await electron.launch({
    args: [OUT_MAIN, '--headless', `--user-data-dir=${dataDir}`, '--draft-interval=300']
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForSelector('.ProseMirror', { timeout: 15000 });
  await window.waitForTimeout(300);
  const handle = { app, window };
  await installDialogStubs(handle, { discard: 1 });
  return handle;
}

/**
 * 模拟崩溃：taskkill /F /T 杀整棵进程树并轮询等待 PID 消失
 * （Playwright 子进程的 kill() 在本机 Windows 上实测不生效）。
 */
async function crash(handle: AppHandle): Promise<void> {
  const pid = handle.app.process().pid;
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
