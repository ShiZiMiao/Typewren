import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchApp,
  closeApp,
  loadContent,
  sendCommand,
  installDialogStubs,
  setDialog,
  type AppHandle
} from './helpers';

let app: AppHandle;

const WORK_DIR = join(tmpdir(), 'typewren-file-test');
const SAVE_PATH = join(WORK_DIR, 'doc.md');
const KNOWN_PATH = join(WORK_DIR, 'known.md');
const RENAME_PATH = join(WORK_DIR, 'renamed.md');
const DIRECT_PATH = join(WORK_DIR, 'direct.md');

test.beforeAll(async () => {
  if (existsSync(WORK_DIR)) rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });
  app = await launchApp();
  // 打桩打开 / 另存为 / 放弃更改三种原生对话框
  await installDialogStubs(app, { saveAs: null, open: null, discard: 1 });
});

test.afterAll(async () => {
  await closeApp(app);
});

/** 在编辑器追加一行文本使文档变脏 */
async function makeDirty(): Promise<void> {
  await app.window.locator('.ProseMirror').click();
  await app.window.keyboard.type('追加内容');
  await app.window.waitForTimeout(300);
}

function readOrNull(filePath: string): string | null {
  return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;
}

test.describe('文件生命周期', () => {
  test('启动基线：欢迎文档不置脏', async () => {
    await expect(app.window.locator('#titlebar-title')).not.toContainText('●');
  });

  test('输入内容后置脏（标题出现 ●）', async () => {
    await loadContent(app, '初始内容', '');
    await expect(app.window.locator('#titlebar-title')).not.toContainText('●');
    await makeDirty();
    await expect(app.window.locator('#titlebar-title')).toContainText('●');
  });

  test('保存（未命名文档 → 另存为）落盘并清除脏标记', async () => {
    await loadContent(app, '初始内容', '');
    await app.window.locator('.ProseMirror').click();
    await app.window.keyboard.type('新段落');
    await app.window.waitForTimeout(300);
    await expect(app.window.locator('#titlebar-title')).toContainText('●');

    setDialog(app, { saveAs: SAVE_PATH });
    await sendCommand(app, 'save');

    await expect.poll(() => readOrNull(SAVE_PATH)).toContain('新段落');
    await expect(app.window.locator('#titlebar-title')).not.toContainText('●');
  });

  test('有路径保存直接写盘（不弹框）', async () => {
    writeFileSync(DIRECT_PATH, '# 原始内容\n', 'utf-8');
    await loadContent(app, '# 原始内容', DIRECT_PATH);
    await app.window.locator('.ProseMirror').click();
    await app.window.keyboard.type('直接保存新增行');
    // 等打字内容真正进入文档模型后再保存
    await expect(app.window.locator('.ProseMirror')).toContainText('直接保存新增行', {
      timeout: 5000
    });
    await app.window.waitForTimeout(300);
    await expect(app.window.locator('#titlebar-title')).toContainText('●');

    await sendCommand(app, 'save');

    await expect.poll(() => readFileSync(DIRECT_PATH, 'utf-8')).toContain('直接保存新增行');
    await expect(app.window.locator('#titlebar-title')).not.toContainText('●');
  });

  test('另存为更新路径与标题', async () => {
    await loadContent(app, '待改名内容', '');
    await makeDirty();

    setDialog(app, { saveAs: RENAME_PATH });
    await sendCommand(app, 'save-as');

    await expect.poll(() => readOrNull(RENAME_PATH)).toContain('待改名内容');
    await expect(app.window.locator('#titlebar-title')).toContainText('renamed.md');
    await expect(app.window.locator('#titlebar-title')).not.toContainText('●');
  });

  test('另存为取消：保留脏状态', async () => {
    await loadContent(app, '', '');
    await makeDirty();
    await expect(app.window.locator('#titlebar-title')).toContainText('●');

    // saveAs 返回取消
    setDialog(app, { saveAs: null });
    await sendCommand(app, 'save-as');

    await app.window.waitForTimeout(300);
    await expect(app.window.locator('#titlebar-title')).toContainText('●');
  });

  test('新建时放弃更改三态', async () => {
    // 取消：文档保持脏
    await loadContent(app, '', '');
    await makeDirty();
    setDialog(app, { discard: 2 });
    await sendCommand(app, 'new-file');
    await app.window.waitForTimeout(300);
    await expect(app.window.locator('.ProseMirror')).toContainText('追加内容');

    // 不保存：文档清空
    setDialog(app, { discard: 1 });
    await sendCommand(app, 'new-file');
    await expect(app.window.locator('.ProseMirror.is-doc-empty')).toBeVisible({ timeout: 5000 });
    await expect(app.window.locator('#titlebar-title')).not.toContainText('●');

    // 保存：先落盘再清空
    await makeDirty();
    setDialog(app, { discard: 0, saveAs: SAVE_PATH });
    await sendCommand(app, 'new-file');
    await expect.poll(() => readOrNull(SAVE_PATH)).toContain('追加内容');
    await expect(app.window.locator('.ProseMirror.is-doc-empty')).toBeVisible({ timeout: 5000 });
  });

  test('打开文件对话框流程', async () => {
    writeFileSync(KNOWN_PATH, '# 打开目标文档\n\n正文段落', 'utf-8');
    setDialog(app, { open: KNOWN_PATH });
    await sendCommand(app, 'open-file');

    await expect(app.window.locator('.ProseMirror h1')).toContainText('打开目标文档', {
      timeout: 5000
    });
    await expect(app.window.locator('#titlebar-title')).toContainText('known.md');
    await expect(app.window.locator('#titlebar-title')).not.toContainText('●');
  });

  test('open-file-path 注入不置脏', async () => {
    writeFileSync(KNOWN_PATH, '# 已知文档', 'utf-8');
    await loadContent(app, '# 已知文档', KNOWN_PATH);
    await expect(app.window.locator('#titlebar-title')).toContainText('known.md');
    await expect(app.window.locator('#titlebar-title')).not.toContainText('●');
  });
});
