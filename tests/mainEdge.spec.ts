import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OUT_MAIN, closeApp, launchApp, loadContent, type AppHandle } from './helpers';
import { coverageLaunchEnv, startCoverage, stopCoverage } from './coverage';

/* ============================================================
 * 主进程边角覆盖（menu/window 的行覆盖补缺）：
 * - 原生菜单项真实点击：命令转发（item click）、关于框、最近文件项；
 * - menu:popup 参数校验与测试模式路径（非法坐标/标签拒绝）；
 * - did-fail-load 合成触发：坏窗销毁 + 异步错误框（-3/非主框不误伤）；
 * - 重复打开同一文档的「转到已有窗口 / 仍在新窗口打开」确认。
 * ============================================================ */

interface DlgRecord {
  title: string;
  message: string;
  detail: string;
  buttons: string[];
}

const dlgLog = (app: ElectronApplication): Promise<DlgRecord[]> =>
  app.evaluate(() => (globalThis as unknown as { __dlgLog: DlgRecord[] }).__dlgLog ?? []);

/** 对话框记录器（响应按队列，默认 0） */
async function installDlgRecorder(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __dlgLog: DlgRecord[]; __dlgQueue: number[] };
    g.__dlgLog = [];
    g.__dlgQueue = [];
    const record = (opts: unknown): number => {
      const o = (opts ?? {}) as {
        title?: string;
        message?: string;
        detail?: string;
        buttons?: string[];
      };
      g.__dlgLog.push({
        title: String(o.title ?? ''),
        message: String(o.message ?? ''),
        detail: String(o.detail ?? ''),
        buttons: o.buttons ?? []
      });
      return g.__dlgQueue.shift() ?? 0;
    };
    const d = dialog as unknown as {
      showMessageBox: (...args: unknown[]) => Promise<{ response: number }>;
      showMessageBoxSync: (...args: unknown[]) => number;
    };
    d.showMessageBox = async (...args: unknown[]) => ({
      response: record(args.length > 1 ? args[1] : args[0])
    });
    d.showMessageBoxSync = (...args: unknown[]) => record(args.length > 1 ? args[1] : args[0]);
  });
}

/** 程序化点击应用菜单项（按 label 前缀，遍历子菜单） */
function clickMenuItem(app: ElectronApplication, labelPrefix: string): Promise<boolean> {
  return app.evaluate(({ Menu }, prefix) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
      for (const item of items) {
        if (item.label === prefix) return item;
        if (item.submenu) {
          const hit = find(item.submenu.items);
          if (hit) return hit;
        }
      }
      return null;
    };
    const item = find(Menu.getApplicationMenu()?.items ?? []);
    item?.click();
    return !!item;
  }, labelPrefix);
}

test('原生菜单项真实点击：命令转发 / 关于框 / 最近文件项', async () => {
  const app: AppHandle = await launchApp();
  const dir = mkdtempSync(join(tmpdir(), 'typewren-menu-'));
  try {
    await installDlgRecorder(app.app);

    // ① 命令项点击：item() 的 click 转发 cmd 到渲染层（新建 → 文档变空）
    await loadContent(app, '# 原有内容\n');
    expect(await clickMenuItem(app.app, '新建')).toBe(true);
    await expect(app.window.locator('.ProseMirror.is-doc-empty')).toBeVisible({ timeout: 5000 });

    // ② 关于框（showMessageBox 异步路径）
    expect(await clickMenuItem(app.app, '关于 Typewren')).toBe(true);
    await expect
      .poll(
        async () =>
          (await dlgLog(app.app)).filter((d) => (d.title + d.message).includes('关于')).length,
        {
          timeout: 5000
        }
      )
      .toBe(1);
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('menu:popup 参数校验：非法坐标/标签拒绝，合法走测试模式路径', async () => {
  const app = await launchApp();
  try {
    // 非法载荷（NaN 坐标 / 未知标签 / 非数字）：均应静默拒绝，不抛错
    await app.window.evaluate(() => {
      const t = (
        window as unknown as {
          typewren: { popupMenu: (l: string, x: number, y: number, s?: unknown) => void };
        }
      ).typewren;
      t.popupMenu('文件', NaN, 1);
      t.popupMenu('不存在的顶级菜单', 10, 10);
      t.popupMenu('文件', 10, 10, { 'view:source': true });
      t.popupMenu('视图', 7.5, 3.2, { 'view:source': true });
    });
    await app.window.waitForTimeout(300);
    // 合法弹出在测试模式不真实弹（防冒菜单到屏幕左上角），窗口保持原状
    await expect(app.window.locator('.ProseMirror')).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

test('原生菜单「最近文件」项点击（--headless 真实模式；--test 下 recents 被禁用）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'typewren-recents-'));
  const p = join(dataDir, 'recent.md');
  writeFileSync(p, '# recent' + String.fromCharCode(10), 'utf-8');
  const launched = await electron.launch({
    args: [OUT_MAIN, '--headless', `--user-data-dir=${dataDir}`],
    env: coverageLaunchEnv()
  });
  try {
    const window = await launched.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForSelector('.ProseMirror', { timeout: 15000 });
    await window.waitForTimeout(400);
    await startCoverage(launched, window);
    await installDlgRecorder(launched);

    // openFileInNewWindow → 新窗 take-pending-open 以 recent 标记登记
    await window.evaluate(
      (path) =>
        (
          window as unknown as { typewren: { openFileInNewWindow: (p: string) => void } }
        ).typewren.openFileInNewWindow(path),
      p
    );
    const recentLabels = () =>
      launched.evaluate(({ Menu }) => {
        const file = Menu.getApplicationMenu()?.items[0];
        const recents = file?.submenu?.items.find((i) => i.label === '最近文件');
        return (recents?.submenu?.items ?? []).map((i) => i.label);
      });
    await expect.poll(recentLabels, { timeout: 8000 }).toContain('recent.md');

    // 点击最近项 → file:open-smart 命令转发（当前空文档就地打开）
    expect(await clickMenuItem(launched, 'recent.md')).toBe(true);
    await expect
      .poll(
        async () =>
          launched.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().map((w) => w.getTitle())
          ),
        { timeout: 8000 }
      )
      .toContainEqual(expect.stringContaining('recent.md'));
  } finally {
    await stopCoverage(launched);
    await launched.close().catch(() => {});
  }
});

test('did-fail-load：主框加载失败销毁窗口 + 异步错误框（-3 中止不误伤）', async () => {
  const app = await launchApp();
  try {
    await installDlgRecorder(app.app);
    // 先开第二窗：销毁唯一窗口会让应用整体退出，断言都做不了
    const secondDir = mkdtempSync(join(tmpdir(), 'typewren-failload-'));
    const second = join(secondDir, 'second.md');
    writeFileSync(second, '# second' + String.fromCharCode(10), 'utf-8');
    await app.window.evaluate(
      (path) =>
        (
          window as unknown as { typewren: { openFileInNewWindow: (p: string) => void } }
        ).typewren.openFileInNewWindow(path),
      second
    );
    await expect
      .poll(
        async () => app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
        {
          timeout: 8000
        }
      )
      .toBe(2);
    await app.app.evaluate(() => {
      (globalThis as unknown as { __dlgLog: unknown[] }).__dlgLog = [];
    });

    // 等全部窗口加载完成：误取仍在 loadFile 中的窗做导航会把原生 loadFile
    // promise 中止、误走 failLoad（getAllWindows 顺序不定，必须先消解在途加载）
    await app.app.evaluate(async ({ BrowserWindow }) => {
      for (let i = 0; i < 50; i += 1) {
        const all = BrowserWindow.getAllWindows();
        if (
          all.length > 0 &&
          // 标题绑定是"文档已领取"的标记（选窗排除法依赖它，抢跑会选错窗）
          all.some((w) => w.getTitle().includes('second')) &&
          all.every((w) => !w.isDestroyed() && !w.webContents.isLoading() && w.webContents.getURL())
        ) {
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    });

    // ① 真实 -3（ERR_ABORTED）：连续导航，前者被后者中止——不得误弹
    await app.app.evaluate(({ BrowserWindow }) => {
      // 标题排除法选 win1（win2 标题是 second.md）；getAllWindows 顺序不定
      const win =
        BrowserWindow.getAllWindows().find((w) => !w.getTitle().includes('second')) ??
        BrowserWindow.getAllWindows()[0];
      const wc = win.webContents;
      const current = wc.getURL();
      void wc.loadURL('file:///Z:/typewren-will-abort.html').catch(() => {});
      void wc.loadURL(current).catch(() => {});
    });
    await app.window.waitForTimeout(800);
    expect(await dlgLog(app.app)).toEqual([]);

    // ② 真实主框加载失败：坏窗销毁 + 异步框（收场文案带中文错误码格式）
    const closed = app.window.waitForEvent('close', { timeout: 8000 });
    await app.app.evaluate(({ BrowserWindow }) => {
      const win =
        BrowserWindow.getAllWindows().find((w) => !w.getTitle().includes('second')) ??
        BrowserWindow.getAllWindows()[0];
      void win.webContents.loadURL('file:///Z:/typewren-missing-page.html').catch(() => {});
    });
    await closed;
    await expect
      .poll(
        async () =>
          (await dlgLog(app.app)).filter((d) => d.message.includes('无法加载编辑器界面')).length,
        {
          timeout: 5000
        }
      )
      .toBe(1);
    const box = (await dlgLog(app.app)).find((d) => d.message.includes('无法加载编辑器界面'))!;
    expect(box.detail).toContain('（错误码');
  } finally {
    await closeApp(app);
  }
});

test('重复打开同一文档：转到已有窗口 / 仍在新窗口打开', async () => {
  const app = await launchApp();
  const dir = mkdtempSync(join(tmpdir(), 'typewren-dup-'));
  try {
    await installDlgRecorder(app.app);
    const p = join(dir, 'dup.md');
    writeFileSync(p, '# 重复\n', 'utf-8');
    await loadContent(app, '# 重复', p);

    // 队列：①选「转到已有窗口」→ 不开新窗
    await app.app.evaluate(() => {
      (globalThis as unknown as { __dlgQueue: number[] }).__dlgQueue.push(0);
    });
    await app.window.evaluate(
      (path) =>
        (
          window as unknown as { typewren: { openFileInNewWindow: (p: string) => void } }
        ).typewren.openFileInNewWindow(path),
      p
    );
    await expect
      .poll(
        async () =>
          (await dlgLog(app.app)).filter((d) => d.message.includes('已在其它窗口打开')).length,
        {
          timeout: 5000
        }
      )
      .toBeGreaterThan(0);
    const wins1 = await app.app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
    );
    expect(wins1).toBe(1);

    // ②选「仍在新窗口打开」→ 新窗口出现
    await app.app.evaluate(() => {
      (globalThis as unknown as { __dlgQueue: number[] }).__dlgQueue.push(1);
    });
    await app.window.evaluate(
      (path) =>
        (
          window as unknown as { typewren: { openFileInNewWindow: (p: string) => void } }
        ).typewren.openFileInNewWindow(path),
      p
    );
    await expect
      .poll(
        async () => app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
        {
          timeout: 8000
        }
      )
      .toBe(2);
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
