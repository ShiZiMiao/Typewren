import { test, expect, _electron as electron } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OUT_MAIN,
  loadContent,
  installDialogStubs,
  setDialog,
  closeApp,
  type AppHandle
} from './helpers';

/* ============================================================
 * 关闭保护（attachCloseGuard）
 * 注意：--test 模式会跳过关闭保护，故这里启动**不带** --test 的真实实例，
 * 通过主进程打桩 showMessageBoxSync 模拟用户三选一。
 * ============================================================ */

const WORK_DIR = join(tmpdir(), 'typewren-close-test');
const SAVE_PATH = join(WORK_DIR, 'guard.md');

async function launchPlain(): Promise<AppHandle> {
  const app = await electron.launch({ args: [OUT_MAIN] });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForSelector('.ProseMirror', { timeout: 15000 });
  await window.waitForTimeout(600);
  const handle = { app, window };
  await installDialogStubs(handle, { saveAs: null, open: null, discard: 1 });
  return handle;
}

/** 向主进程请求关闭当前窗口（触发关闭保护） */
function requestWindowClose(handle: AppHandle): Promise<void> {
  return handle.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close();
  });
}

/** 强制销毁所有窗口（绕过关闭保护，用于测试收尾） */
function forceDestroy(handle: AppHandle): Promise<void> {
  return handle.app
    .evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.destroy();
    })
    .catch(() => {});
}

test.describe('关闭保护', () => {
  test.beforeAll(() => {
    if (existsSync(WORK_DIR)) rmSync(WORK_DIR, { recursive: true, force: true });
    mkdirSync(WORK_DIR, { recursive: true });
  });

  test('脏文档关闭时"取消"：窗口保持打开', async () => {
    const handle = await launchPlain();
    try {
      await loadContent(handle, '关闭保护测试', '');
      await handle.window.locator('.ProseMirror').click();
      await handle.window.keyboard.type('脏内容');
      await handle.window.waitForTimeout(300);

      setDialog(handle, { discard: 2 });
      await requestWindowClose(handle);
      await handle.window.waitForTimeout(600);

      const destroyed = await handle.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isDestroyed()
      );
      expect(destroyed).toBe(false);
    } finally {
      // 取消场景下窗口不可见，closeApp 会被关闭保护挡着，需先 destroy
      await forceDestroy(handle);
      await closeApp(handle);
    }
  });

  test('脏文档选择"不保存"：窗口关闭', async () => {
    const handle = await launchPlain();
    try {
      await loadContent(handle, '# 内容', '');
      await handle.window.locator('.ProseMirror').click();
      await handle.window.keyboard.type('脏');
      await handle.window.waitForTimeout(300);

      setDialog(handle, { discard: 1 });
      const closed = handle.window.waitForEvent('close', { timeout: 10000 }).then(() => true);
      await requestWindowClose(handle);
      expect(await closed).toBe(true);
    } finally {
      await closeApp(handle);
    }
  });

  test('脏文档选择"保存"：先保存再关闭', async () => {
    const handle = await launchPlain();
    try {
      await loadContent(handle, '# 保存后关闭', '');
      await handle.window.locator('.ProseMirror').click();
      await handle.window.keyboard.type('待保存');
      await handle.window.waitForTimeout(300);

      setDialog(handle, { discard: 0, saveAs: SAVE_PATH });
      const closed = handle.window.waitForEvent('close', { timeout: 10000 }).then(() => true);
      await requestWindowClose(handle);

      expect(await closed).toBe(true);
      await expect
        .poll(() => (existsSync(SAVE_PATH) ? readFileSync(SAVE_PATH, 'utf-8') : null))
        .toContain('待保存');
    } finally {
      await closeApp(handle);
    }
  });

  test('干净文档关闭不弹确认', async () => {
    const handle = await launchPlain();
    try {
      await loadContent(handle, '干净文档', '');
      const closed = handle.window.waitForEvent('close', { timeout: 10000 }).then(() => true);
      await requestWindowClose(handle);
      expect(await closed).toBe(true);
    } finally {
      await closeApp(handle);
    }
  });
});
