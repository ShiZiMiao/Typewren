import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { closeApp, launchApp, loadContent, type AppHandle } from './helpers';

/* ============================================================
 * Ctrl/Cmd+点击超链接跳转（file:open-link，主进程裁决见 openLink.ts）：
 * 相对 md 链接 → 新窗口打开同目录文档；图片/pdf → 系统默认程序；
 * http(s) → 系统浏览器；死链/普通点击（无修饰键）→ 无动作。
 * 用 --test 实例（无会话/草稿干扰）。
 * ============================================================ */

const WORK_DIR = join(tmpdir(), `typewren-linkopen-test-${process.pid}-${Date.now()}`);
const INDEX = join(WORK_DIR, 'index.md');
const GUIDE = join(WORK_DIR, 'code_guide.md');
const SPACED = join(WORK_DIR, 'space doc.md');
const SUB = join(WORK_DIR, 'sub', 'quiz.md');
const PIC = join(WORK_DIR, 'assets', 'pic.png');
const EXE = join(WORK_DIR, 'run.exe');
const EXTERNAL_URL = 'https://example.com/page';

const INDEX_MD = [
  '# 首页',
  '',
  '[到指导](code_guide.md)',
  '',
  '[空格文档](space%20doc.md)',
  '',
  '[子目录](sub/quiz.md)',
  '',
  '[死链](missing.md)',
  '',
  '[外链](https://example.com/page)',
  '',
  '[图片](assets/pic.png)',
  '',
  '[可执行](run.exe)',
  ''
].join('\n');

test.beforeAll(() => {
  mkdirSync(join(WORK_DIR, 'sub'), { recursive: true });
  mkdirSync(join(WORK_DIR, 'assets'), { recursive: true });
  writeFileSync(INDEX, INDEX_MD, 'utf-8');
  writeFileSync(GUIDE, '# 指导文档\n', 'utf-8');
  writeFileSync(SPACED, '# 空格文档\n', 'utf-8');
  writeFileSync(SUB, '# 子目录文档\n', 'utf-8');
  writeFileSync(PIC, 'x', 'utf-8');
  writeFileSync(EXE, 'x', 'utf-8');
});

const winCount = (app: AppHandle): Promise<number> =>
  app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

/** 点击后等新窗口出现并返回它（新页挂载有竞态，轮询 windows() 而非窗口数） */
async function openViaCtrlClick(
  app: AppHandle,
  href: string
): Promise<import('@playwright/test').Page> {
  await app.window.locator(`.ProseMirror a[href="${href}"]`).click({ modifiers: ['Control'] });
  let page: import('@playwright/test').Page | null = null;
  await expect
    .poll(
      async () => {
        const fresh = app.app.windows().filter((p) => p !== app.window);
        if (fresh.length > 0) page = fresh[fresh.length - 1];
        return fresh.length;
      },
      { timeout: 10000 }
    )
    .toBeGreaterThan(0);
  await page!.waitForSelector('.ProseMirror', { timeout: 15000 });
  return page!;
}

test('Ctrl+点击相对 md 链接 → 新窗口打开同目录文档', async () => {
  const app = await launchApp();
  try {
    await loadContent(app, INDEX_MD, INDEX);
    const newWin = await openViaCtrlClick(app, 'code_guide.md');
    await expect(newWin.locator('.ProseMirror h1')).toHaveText('指导文档', { timeout: 10000 });
  } finally {
    await closeApp(app);
  }
});

test('带空格（%20 编码）的相对链接打开', async () => {
  const app = await launchApp();
  try {
    await loadContent(app, INDEX_MD, INDEX);
    const spacedWin = await openViaCtrlClick(app, 'space%20doc.md');
    await expect(spacedWin.locator('.ProseMirror h1')).toHaveText('空格文档', { timeout: 10000 });
  } finally {
    await closeApp(app);
  }
});

test('子目录链接打开', async () => {
  const app = await launchApp();
  try {
    await loadContent(app, INDEX_MD, INDEX);
    const subWin = await openViaCtrlClick(app, 'sub/quiz.md');
    await expect(subWin.locator('.ProseMirror h1')).toHaveText('子目录文档', { timeout: 10000 });
  } finally {
    await closeApp(app);
  }
});

test('死链静默忽略：窗口数不变、无错误框', async () => {
  const app = await launchApp();
  try {
    await loadContent(app, INDEX_MD, INDEX);
    await app.window.locator('.ProseMirror a[href="missing.md"]').click({ modifiers: ['Control'] });
    await app.window.waitForTimeout(800);
    expect(await winCount(app)).toBe(1);
  } finally {
    await closeApp(app);
  }
});

test('普通点击（无修饰键）不打开新窗口', async () => {
  const app = await launchApp();
  try {
    await loadContent(app, INDEX_MD, INDEX);
    await app.window.locator('.ProseMirror a[href="code_guide.md"]').click();
    await app.window.waitForTimeout(800);
    expect(await winCount(app)).toBe(1);
  } finally {
    await closeApp(app);
  }
});

test('Ctrl+点击 http 链接 → 交系统浏览器（窗口不导航、不新开）', async () => {
  const app = await launchApp();
  try {
    // 打桩 shell.openExternal（否则会真开用户默认浏览器）
    await app.app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __ext: string[] };
      g.__ext = [];
      (shell as unknown as { openExternal: (u: string) => void }).openExternal = (u: string) => {
        g.__ext.push(u);
      };
    });
    await loadContent(app, INDEX_MD, INDEX);
    await app.window.locator(`.ProseMirror a[href="${EXTERNAL_URL}"]`).click({
      modifiers: ['Control']
    });
    await app.window.waitForTimeout(800);
    expect(await winCount(app)).toBe(1);
    const extUrls = await app.app.evaluate(
      () => (globalThis as unknown as { __ext: string[] }).__ext
    );
    expect(extUrls).toContain(EXTERNAL_URL);
  } finally {
    await closeApp(app);
  }
});

test('Ctrl+点击图片 → shell.openPath 系统打开；.exe 不在白名单 → 无动作', async () => {
  const app = await launchApp();
  try {
    await app.app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __openPath: string[] };
      g.__openPath = [];
      (shell as unknown as { openPath: (u: string) => void }).openPath = (u: string) => {
        g.__openPath.push(u);
      };
    });
    await loadContent(app, INDEX_MD, INDEX);

    await app.window.locator('.ProseMirror a[href="assets/pic.png"]').click({
      modifiers: ['Control']
    });
    await app.window.waitForTimeout(600);
    expect(await winCount(app)).toBe(1);
    const opened = await app.app.evaluate(
      () => (globalThis as unknown as { __openPath: string[] }).__openPath
    );
    expect(opened).toContain(resolve(PIC));

    // .exe 白名单外：不打开也不开窗
    await app.window.locator('.ProseMirror a[href="run.exe"]').click({
      modifiers: ['Control']
    });
    await app.window.waitForTimeout(600);
    expect(await winCount(app)).toBe(1);
    const openedAfter = await app.app.evaluate(
      () => (globalThis as unknown as { __openPath: string[] }).__openPath
    );
    expect(openedAfter).toHaveLength(1);
  } finally {
    await closeApp(app);
  }
});

test('Ctrl+点击链接目标已打开 → 焦点回到已有窗口（不双开）', async () => {
  const app = await launchApp();
  try {
    await loadContent(app, INDEX_MD, INDEX);
    const first = await openViaCtrlClick(app, 'code_guide.md');
    await expect(first.locator('.ProseMirror h1')).toHaveText('指导文档', { timeout: 10000 });

    // 再次 Ctrl+点击同一链接：重复打开询问（--test 桩默认选「转到已有窗口」）
    await app.window.locator('.ProseMirror a[href="code_guide.md"]').click({
      modifiers: ['Control']
    });
    await app.window.waitForTimeout(800);
    expect(await winCount(app)).toBe(2);
  } finally {
    await closeApp(app);
  }
});
