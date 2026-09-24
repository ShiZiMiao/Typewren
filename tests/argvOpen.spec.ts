import { test, expect, _electron as electron } from '@playwright/test';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OUT_MAIN, launchApp } from './helpers';

/* ============================================================
 * 启动参数与多窗口（index.ts extractMarkdownPath / second-instance /
 * file:open-in-new-window / file:take-pending-open 拉取链路）
 * ============================================================ */

const WORK_DIR = join(tmpdir(), 'typewren-argv-test');
const DOC_A = join(WORK_DIR, 'argv-a.md');
const DOC_B = join(WORK_DIR, 'argv-b.md');

function createDoc(filePath: string, heading: string): void {
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(filePath, `# ${heading}\n\n正文内容`, 'utf-8');
}

test.beforeAll(() => {
  if (existsSync(WORK_DIR)) rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });
});

/** 等新窗口完成渲染并断言其一级标题 */
async function expectHeadingInWindow(
  window: Awaited<ReturnType<typeof launchApp>>['window'],
  heading: string
): Promise<void> {
  await window.waitForSelector('.ProseMirror', { timeout: 15000 });
  await expect(window.locator('.ProseMirror h1')).toHaveText(heading, { timeout: 10000 });
}

test('命令行参数打开 Markdown 文件', async () => {
  createDoc(DOC_A, '命令行打开的文档');
  const app = await electron.launch({ args: ['--test', OUT_MAIN, DOC_A] });
  const window = await app.firstWindow();
  try {
    await expectHeadingInWindow(window, '命令行打开的文档');
  } finally {
    await app.close().catch(() => {});
  }
});

test('单横线文件名参数可打开（只跳过 -- 开头的开关参数）', async () => {
  // 回归：参数扫描曾跳过所有 '-' 开头的参数，`typewren -notes.md` 这类
  // 单横线命名的文件打不开；现仅跳过 '--' 开头的开关，其余按扩展名白名单判定
  const relName = '-notes.md';
  writeFileSync(join(WORK_DIR, relName), '# 单横线文件名\n\n正文内容', 'utf-8');
  const app = await electron.launch({
    args: ['--test', OUT_MAIN, relName],
    // 相对路径参数按进程 cwd 解析（模拟 shell 里 `typewren -notes.md`）
    cwd: WORK_DIR
  });
  const window = await app.firstWindow();
  try {
    await expectHeadingInWindow(window, '单横线文件名');
  } finally {
    await app.close().catch(() => {});
  }
});

test('二次启动实例把文件交给首实例：新开窗口打开（second-instance 接线）', async () => {
  const first = await launchApp();
  try {
    // 真实二次启动会因单实例锁立即退出（Playwright 视为异常），
    // 这里在主进程内人工派发 second-instance 事件验证处理链路由。
    createDoc(DOC_B, '二次启动传递的文档');
    const [secondWin] = await Promise.all([
      first.app.waitForEvent('window'),
      first.app.evaluate(
        ({ app }, argv) => {
          app.emit('second-instance', {} as Electron.Event, argv);
        },
        [process.execPath, '--test', OUT_MAIN, DOC_B]
      )
    ]);

    // 文件总是在新窗口打开，首窗口不受影响
    await expectHeadingInWindow(secondWin, '二次启动传递的文档');
    await expect(first.window.locator('.ProseMirror')).toBeVisible();
    expect(
      await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    ).toBe(2);
  } finally {
    await first.app.close().catch(() => {});
  }
});

test('file:open-in-new-window 通道：渲染进程就绪后经 take-pending-open 拉取文件', async () => {
  const first = await launchApp();
  try {
    createDoc(DOC_B, '新窗口打开的文档');
    const [secondWin] = await Promise.all([
      first.app.waitForEvent('window'),
      first.window.evaluate((p: string) => {
        const api = (window as unknown as { typewren: { openFileInNewWindow(path: string): void } })
          .typewren;
        api.openFileInNewWindow(p);
      }, DOC_B)
    ]);
    await expectHeadingInWindow(secondWin, '新窗口打开的文档');
  } finally {
    await first.app.close().catch(() => {});
  }
});
