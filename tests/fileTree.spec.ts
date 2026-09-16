import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeApp, launchApp, loadContent } from './helpers';

/* ============================================================
 * 文件树面板（docRegistry + dir:list 子树校验）
 * ============================================================ */

const RUN_ID = `${process.pid}-${Date.now()}`;
const WORK_DIR = join(tmpdir(), `typewren-filetree-test-${RUN_ID}`);

test.beforeAll(() => {
  if (existsSync(WORK_DIR)) rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(join(WORK_DIR, 'notes', 'sub'), { recursive: true });
  writeFileSync(join(WORK_DIR, 'notes', 'alpha.md'), '# Alpha\n');
  writeFileSync(join(WORK_DIR, 'notes', 'beta.md'), '# Beta\n');
  writeFileSync(join(WORK_DIR, 'notes', 'other.txt'), 'not markdown');
  writeFileSync(join(WORK_DIR, 'notes', 'sub', 'deep.md'), '# Deep\n');
});

test('文件树：tab 切换列出同目录 md、点击进入子目录导航', async () => {
  const app = await launchApp();
  try {
    await loadContent(app, '# 文件树测试', join(WORK_DIR, 'notes', 'alpha.md'));
    await app.window.waitForTimeout(400);

    // 默认在大纲 tab → 切到「文件」tab（侧栏卡片切换）
    await app.window.locator('#side-panel .side-tab[data-tab="files"]').click();
    await app.window.waitForTimeout(400);

    // 列出 alpha/beta/sub（other.txt 应被过滤）
    const items = app.window.locator('#filetree-items .filetree-item');
    await expect(items).toHaveCount(3);
    await expect(items.filter({ hasText: 'alpha.md' })).toHaveCount(1);
    await expect(items.filter({ hasText: 'beta.md' })).toHaveCount(1);
    await expect(items.filter({ hasText: 'other' })).toHaveCount(0);

    // 当前文档高亮
    await expect(app.window.locator('.ProseMirror h1')).toHaveText('文件树测试');

    // 点击子树进入
    await app.window.locator('#filetree-items .filetree-item', { hasText: 'sub' }).click();
    await expect(
      app.window.locator('#filetree-items .filetree-item', { hasText: 'deep.md' })
    ).toHaveCount(1);
    await expect(
      app.window.locator('#filetree-items .filetree-nav', { hasText: '返回上级' })
    ).toBeVisible();

    // 返回上级
    await app.window.locator('#filetree-items .filetree-nav', { hasText: '返回上级' }).click();
    await expect(items.filter({ hasText: 'alpha.md' })).toHaveCount(1);
  } finally {
    await closeApp(app);
  }
});

test('保存后文件树显示同目录文件', async () => {
  const app = await launchApp();
  try {
    await loadContent(app, '# 未命名', '');
    await app.window.waitForTimeout(400);
    // tab 先切到文件卡片
    await app.window.locator('#side-panel .side-tab[data-tab="files"]').click();
    await app.window.waitForTimeout(300);
    await expect(app.window.locator('#filetree-items .filetree-empty')).toHaveText(
      /保存文档后显示/
    );
  } finally {
    await closeApp(app);
  }
});
