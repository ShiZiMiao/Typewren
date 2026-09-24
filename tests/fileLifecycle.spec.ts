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

    await setDialog(app, { saveAs: SAVE_PATH });
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

    await setDialog(app, { saveAs: RENAME_PATH });
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
    await setDialog(app, { saveAs: null });
    await sendCommand(app, 'save-as');

    await app.window.waitForTimeout(300);
    await expect(app.window.locator('#titlebar-title')).toContainText('●');
  });

  test('新建时放弃更改三态', async () => {
    // 取消：文档保持脏
    await loadContent(app, '', '');
    await makeDirty();
    await setDialog(app, { discard: 2 });
    await sendCommand(app, 'new-file');
    await app.window.waitForTimeout(300);
    await expect(app.window.locator('.ProseMirror')).toContainText('追加内容');

    // 不保存：文档清空
    await setDialog(app, { discard: 1 });
    await sendCommand(app, 'new-file');
    await expect(app.window.locator('.ProseMirror.is-doc-empty')).toBeVisible({ timeout: 5000 });
    await expect(app.window.locator('#titlebar-title')).not.toContainText('●');

    // 保存：先落盘再清空
    await makeDirty();
    await setDialog(app, { discard: 0, saveAs: SAVE_PATH });
    await sendCommand(app, 'new-file');
    await expect.poll(() => readOrNull(SAVE_PATH)).toContain('追加内容');
    await expect(app.window.locator('.ProseMirror.is-doc-empty')).toBeVisible({ timeout: 5000 });
  });

  test('打开文件对话框流程', async () => {
    writeFileSync(KNOWN_PATH, '# 打开目标文档\n\n正文段落', 'utf-8');
    await setDialog(app, { open: KNOWN_PATH });
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

  // ========== 回归：基线必须 content+doc 同一瞬间成对 ==========

  test('保存间隙继续键入：不丢字、保持脏（fix 回归）', async () => {
    await loadContent(app, '初始内容', '');
    await app.window.locator('.ProseMirror').click();
    await app.window.keyboard.type('保存前');
    await expect(app.window.locator('.ProseMirror')).toContainText('保存前', { timeout: 5000 });
    await app.window.waitForTimeout(300);

    // 另存为对话框桩换为延迟版：doSaveAs 在弹框前已捕获 content/doc（成对基线），
    // 对话框停留期间的键入不得进基线——旧实现基线取在写盘 await 之后，会把
    // 间隙键入烧进基线导致 isDirty 假阴（关闭保护不弹、静默丢字）
    await app.app.evaluate(
      ({ dialog: d }, p) => {
        const g = globalThis as unknown as { __saveDialogOpened?: boolean };
        const e = d as unknown as {
          showSaveDialog: (...args: unknown[]) => Promise<{ canceled: boolean; filePath?: string }>;
        };
        e.showSaveDialog = async () => {
          g.__saveDialogOpened = true;
          await new Promise((r) => setTimeout(r, p.delayMs));
          return { canceled: false, filePath: p.path };
        };
      },
      { path: SAVE_PATH, delayMs: 1000 }
    );
    await sendCommand(app, 'save');
    // 等对话框真正开始（= content 已捕获）再键入，保证键入落在保存间隙里
    await expect
      .poll(() =>
        app.app.evaluate(() => {
          const g = globalThis as unknown as { __saveDialogOpened?: boolean };
          return g.__saveDialogOpened === true;
        })
      )
      .toBe(true);
    await app.window.keyboard.type('保存间隙追加');

    await expect.poll(() => readOrNull(SAVE_PATH)).toContain('保存前');
    // 间隙键入仍在文档里，且没有被烧进基线：文档必须保持脏
    await expect(app.window.locator('.ProseMirror')).toContainText('保存间隙追加');
    await expect(app.window.locator('#titlebar-title')).toContainText('●', { timeout: 5000 });

    // 恢复默认对话框桩（本用例替换过 showSaveDialog）
    await installDialogStubs(app, {});
  });

  test('源码模式下保存后退出写回：不假脏（fix 回归）', async () => {
    writeFileSync(DIRECT_PATH, '# 源码保存\n', 'utf-8');
    await loadContent(app, '# 源码保存', DIRECT_PATH);
    await app.window.waitForTimeout(200);

    // 进源码模式改内容并保存：doSave 的 doc 基线取的是渲染视图过期 doc
    await sendCommand(app, 'view:source');
    await app.window.waitForTimeout(250);
    await app.window.locator('#source-textarea').click();
    await app.window.keyboard.type('，源码改过');
    await app.window.waitForTimeout(250);
    await sendCommand(app, 'save');
    await expect.poll(() => readFileSync(DIRECT_PATH, 'utf-8')).toContain('源码改过');
    await app.window.waitForTimeout(300);

    // 退出源码（重新 parse 写回）：写回文本与磁盘基线一致时必须回干净，
    // 否则"刚保存仍显示 ●、关闭误弹"（过期 baselineDoc 与新 parse 产物不等）
    await sendCommand(app, 'view:source');
    await app.window.waitForTimeout(500);
    await expect(app.window.locator('#titlebar-title')).not.toContainText('●', { timeout: 5000 });
  });
});
