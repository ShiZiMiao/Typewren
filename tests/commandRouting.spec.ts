import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeApp, launchApp, loadContent, sendCommand, type AppHandle } from './helpers';

/* ============================================================
 * 菜单命令路径（cmd → commandRouter）补缺：
 * 键盘快捷键/设置直改各有归属测试，这里专测此前无用例直达的
 * 命令路由面——edit:find / edit:replace（幂等语义）、
 * edit:auto-pairs（命令切换）、global:show-in-folder（系统定位）、
 * discard-close（放弃更改强制关窗）。
 * ============================================================ */

let app: AppHandle;
let dir: string;

test.beforeAll(async () => {
  app = await launchApp();
  dir = mkdtempSync(join(tmpdir(), 'typewren-cmd-test-'));
});

test.afterAll(async () => {
  await closeApp(app);
  rmSync(dir, { recursive: true, force: true });
});

test('edit:find / edit:replace 命令路径：搜索栏开合与替换行（幂等）', async () => {
  await loadContent(app, '# 命令路由\n\n搜索目标内容\n');
  const bar = app.window.locator('#search-bar');
  await expect(bar).toBeHidden();

  await sendCommand(app, 'edit:find');
  await expect(bar).toBeVisible();
  await expect(app.window.locator('#replace-row')).toBeHidden();

  // edit:replace：确保打开 + 替换行可见
  await sendCommand(app, 'edit:replace');
  await expect(bar).toBeVisible();
  await expect(app.window.locator('#replace-row')).toBeVisible();

  // 幂等：替换行已开时再发一次不得把整个搜索栏关掉（旧实现 toggle 组合误关）
  await sendCommand(app, 'edit:replace');
  await expect(bar).toBeVisible();
  await expect(app.window.locator('#replace-row')).toBeVisible();

  // edit:find 是开合语义：关闭
  await sendCommand(app, 'edit:find');
  await expect(bar).toBeHidden();
});

test('edit:auto-pairs 命令切换成对补全', async () => {
  // 默认开启：行首输入 ( 自动补全成对
  await loadContent(app, '');
  await app.window.locator('.ProseMirror').click();
  await app.window.keyboard.type('(');
  await expect(app.window.locator('.ProseMirror')).toContainText('()');

  // 命令关闭：不再补全
  await sendCommand(app, 'edit:auto-pairs');
  await loadContent(app, '');
  await app.window.locator('.ProseMirror').click();
  await app.window.keyboard.type('(');
  await app.window.waitForTimeout(150);
  const text = (await app.window.locator('.ProseMirror').textContent()) ?? '';
  expect(text).toBe('(');

  // 命令恢复开启（不给同实例后续用例留副作用）
  await sendCommand(app, 'edit:auto-pairs');
  await loadContent(app, '');
  await app.window.locator('.ProseMirror').click();
  await app.window.keyboard.type('[');
  await expect(app.window.locator('.ProseMirror')).toContainText('[]');
});

test('global:show-in-folder 命令：已保存文档调系统定位，未保存不调用', async () => {
  const filePath = join(dir, 'located.md');
  writeFileSync(filePath, '# 定位\n', 'utf-8');
  await loadContent(app, '# 定位', filePath);

  await app.app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __shown: string[] };
    g.__shown = [];
    (shell as unknown as { showItemInFolder: (p: string) => void }).showItemInFolder = (p) => {
      g.__shown.push(p);
    };
  });

  await sendCommand(app, 'global:show-in-folder');
  await expect
    .poll(() =>
      app.app.evaluate(() => (globalThis as unknown as { __shown: string[] }).__shown ?? [])
    )
    .toEqual([filePath]);

  // 未保存文档（无路径）：不发起系统定位
  await loadContent(app, '无路径文档');
  await sendCommand(app, 'global:show-in-folder');
  await app.window.waitForTimeout(300);
  const shown = await app.app.evaluate(
    () => (globalThis as unknown as { __shown: string[] }).__shown ?? []
  );
  expect(shown).toEqual([filePath]);
});

test('discard-close 命令：放弃更改强制关窗（不留关闭保护弹窗）', async () => {
  // 关窗用独立实例（本用例的窗口会被关掉）
  const local = await launchApp();
  try {
    await loadContent(local, '# 待放弃\n\n');
    await local.window.locator('.ProseMirror').click();
    await local.window.keyboard.type('未保存改动');
    await expect(local.window.locator('#titlebar-title')).toContainText('●');

    const closed = local.window.waitForEvent('close', { timeout: 8000 });
    await sendCommand(local, 'discard-close');
    await closed;
  } finally {
    await local.app.close().catch(() => {});
  }
});
