import { test, expect, _electron as electron } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OUT_MAIN, installDialogStubs, closeApp, type AppHandle } from './helpers';

/* ============================================================
 * 第二档：会话恢复 / 最近文件 / 重复打开询问
 * 会话与最近文件在 --test 下整体禁用，必须用不带 --test 的
 * 真实实例 + 独立 --user-data-dir（顺带隔离 localStorage/草稿）。
 * ============================================================ */

const RUN_ID = `${process.pid}-${Date.now()}`;
const WORK_DIR = join(tmpdir(), `typewren-session-test-${RUN_ID}`);
const DATA_DIR = join(WORK_DIR, 'userdata');
const DOC_A = join(WORK_DIR, 'a.md');
const DOC_B = join(WORK_DIR, 'b.md');

function createDoc(filePath: string, heading: string): void {
  writeFileSync(filePath, `# ${heading}\n\n正文`, 'utf-8');
}

async function launch(extraArgs: string[]): Promise<AppHandle> {
  const app = await electron.launch({
    args: [OUT_MAIN, '--headless', `--user-data-dir=${DATA_DIR}`, ...extraArgs]
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForSelector('.ProseMirror', { timeout: 15000 });
  await window.waitForTimeout(300);
  const handle = { app, window };
  await installDialogStubs(handle, { discard: 1, confirm: 0 });
  return handle;
}

test.beforeAll(() => {
  mkdirSync(WORK_DIR, { recursive: true });
  createDoc(DOC_A, '会话恢复文档甲');
  createDoc(DOC_B, '会话恢复文档乙');
});

test('关闭后重启：所有打开过的文档按窗口恢复', async () => {
  // 首启：命令行打开 A
  const first = await launch([DOC_A]);
  await expect(first.window.locator('.ProseMirror h1')).toHaveText('会话恢复文档甲', {
    timeout: 15000
  });

  // 经 open-in-new-window 开 B（重复检测不命中 → 直接开新窗）
  const [winB] = await Promise.all([
    first.app.waitForEvent('window'),
    first.window.evaluate((p: string) => {
      const api = (window as unknown as { typewren: { openFileInNewWindow(path: string): void } })
        .typewren;
      api.openFileInNewWindow(p);
    }, DOC_B)
  ]);
  await winB.waitForSelector('.ProseMirror', { timeout: 15000 });
  await expect(winB.locator('.ProseMirror h1')).toHaveText('会话恢复文档乙', { timeout: 15000 });

  // 带窗退出（等价于「文件 → 退出」：before-quit 时窗口仍在，会话完整落盘；
  // 若用 app.close() 则窗口先关光，语义变成"用户关闭了所有窗口"）
  const exited = new Promise<void>((r) => first.app.process().once('exit', () => r()));
  await first.app.evaluate(({ app }) => app.quit());
  await exited;
  await first.app.close().catch(() => {});

  // 重启（无参数）→ 会话恢复出两个窗口，各开 A/B
  const second = await launch([]);
  try {
    await expect(second.window.locator('.ProseMirror h1')).toHaveText(
      /(会话恢复文档甲|会话恢复文档乙)/,
      { timeout: 15000 }
    );
    const winCount = async () =>
      second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    await expect.poll(winCount).toBe(2);

    // 两窗口内容互补（顺序取决于会话记录，不做强断言）
    const texts = await Promise.all(
      second.app.windows().map((w) => w.locator('.ProseMirror h1').textContent())
    );
    expect(new Set(texts)).toEqual(new Set(['会话恢复文档甲', '会话恢复文档乙']));

    // 最近文件落盘且 MRU 排序（最后打开/恢复操作都会记录）
    await second.window.waitForTimeout(700); // 等 win:set-path → recent.json
    const recent = JSON.parse(readFileSync(join(DATA_DIR, 'recent.json'), 'utf-8')) as string[];
    expect(recent.some((p) => p.endsWith('a.md'))).toBe(true);
    expect(recent.some((p) => p.endsWith('b.md'))).toBe(true);
  } finally {
    await closeApp(second);
  }
});

test('重复打开已开文档：默认应答转到已有窗口，不再开新窗', async () => {
  const first = await launch([DOC_A]);
  await expect(first.window.locator('.ProseMirror h1')).toHaveText('会话恢复文档甲', {
    timeout: 15000
  });

  // confirm 桩默认 0（转到已有窗口）
  await first.window.evaluate((p: string) => {
    const api = (window as unknown as { typewren: { openFileInNewWindow(path: string): void } })
      .typewren;
    api.openFileInNewWindow(p);
  }, DOC_A);
  await first.window.waitForTimeout(800);
  expect(
    await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  ).toBe(1);
  await closeApp(first);
});

test('重复打开时选择仍在新窗口打开：新开窗口', async () => {
  const first = await launch([DOC_A]);
  await expect(first.window.locator('.ProseMirror h1')).toHaveText('会话恢复文档甲', {
    timeout: 15000
  });
  await installDialogStubs(first, { discard: 1, confirm: 1 }); // 第二按钮：仍开新窗
  const [dupWin] = await Promise.all([
    first.app.waitForEvent('window'),
    first.window.evaluate((p: string) => {
      const api = (window as unknown as { typewren: { openFileInNewWindow(path: string): void } })
        .typewren;
      api.openFileInNewWindow(p);
    }, DOC_A)
  ]);
  await dupWin.waitForSelector('.ProseMirror', { timeout: 15000 });
  expect(
    await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  ).toBe(2);
  await closeApp(first);
});
