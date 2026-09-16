import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeApp, launchApp, loadContent, type AppHandle } from './helpers';

/* ============================================================
 * file:open-smart（最近文件菜单与「文件→打开…」共用路由）：
 * 空文档 → 就地打开；非空 → 新窗口打开。
 * 用 --test 实例（无会话/草稿干扰，窗口启动即空白）。
 * ============================================================ */

const WORK_DIR = join(tmpdir(), `typewren-opensmart-test-${process.pid}-${Date.now()}`);
const DOC_A = join(WORK_DIR, 'a.md');
const DOC_B = join(WORK_DIR, 'b.md');

function sendOpenSmart(handle: AppHandle, path: string): Promise<void> {
  return handle.app.evaluate(({ BrowserWindow }, p) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    win.webContents.send('cmd', 'file:open-smart', p);
  }, path);
}

const winCount = (app: AppHandle): Promise<number> =>
  app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

test.beforeAll(() => {
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(DOC_A, '# 甲文档\n', 'utf-8');
  writeFileSync(DOC_B, '# 乙文档\n', 'utf-8');
});

test('空文档窗口：open-smart 就地打开（不新增窗口）', async () => {
  const app = await launchApp();
  try {
    // 启动即空白文档（无路径、不脏）
    expect(await winCount(app)).toBe(1);

    await sendOpenSmart(app, DOC_A);
    await app.window.waitForTimeout(600);

    expect(await winCount(app)).toBe(1);
    await expect(app.window.locator('.ProseMirror h1')).toHaveText('甲文档', {
      timeout: 10000
    });
  } finally {
    await closeApp(app);
  }
});

test('非空窗口：open-smart 新窗口打开', async () => {
  const app = await launchApp();
  try {
    // 有路径的文档 → 非空
    await loadContent(app, '# 占位', DOC_B);
    await app.window.waitForTimeout(300);
    expect(await winCount(app)).toBe(1);

    await sendOpenSmart(app, DOC_A);
    await app.window.waitForTimeout(800);

    expect(await winCount(app)).toBe(2);
    // 新窗口显示甲文档
    const newWin = app.app.windows()[1];
    await expect(newWin.locator('.ProseMirror h1')).toHaveText('甲文档', { timeout: 10000 });
  } finally {
    await closeApp(app);
  }
});
