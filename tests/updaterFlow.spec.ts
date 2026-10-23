import { test, expect, type ElectronApplication } from '@playwright/test';
import { closeApp, launchApp, type AppHandle } from './helpers';

/* ============================================================
 * 更新器状态机 e2e（updater.ts 事件驱动打桩）：
 * e2e 跑 out/ 产物属未打包环境，checkForUpdates 首行就短路——
 * 在主进程覆写 app.isPackaged + 打桩 electron-updater 单例
 * （externalized 依赖，与 updater.ts 是同一模块实例），再用
 * 原生菜单「检查更新…」真实点击驱动全流程：发现新版 → 下载
 * 进度 → 就绪 → 安装 / 查看日志 / 取消 / 失败 / 已最新 /
 * 开发守卫。对话框按队列返回按钮下标并全量记录。
 * ============================================================ */

interface DlgLogItem {
  message: string;
  detail: string;
  buttons: string[];
}

interface CheckConfig {
  mode: 'available' | 'none' | 'throw';
  version: string;
  notes: string;
  errorMessage: string;
  /** 检查桩的模拟耗时（在途反馈「正在检查更新」的可断言窗口） */
  delayMs: number;
}

interface UpdState {
  quit: number;
  opened: string[];
  downloadCalls: number;
  dlgLog: DlgLogItem[];
  dlgQueue: number[];
  check: CheckConfig;
}

const updState = (app: ElectronApplication): Promise<UpdState> =>
  app.evaluate(() => (globalThis as unknown as { __upd: UpdState }).__upd);

/** 对话框记录器 + autoUpdater 记录桩（不改 isPackaged） */
async function installUpdStubs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog, shell }) => {
    const g = globalThis as unknown as { __upd: UpdState };
    g.__upd = {
      quit: 0,
      opened: [],
      downloadCalls: 0,
      dlgLog: [],
      dlgQueue: [],
      check: { mode: 'available', version: '9.9.9', notes: '', errorMessage: 'boom', delayMs: 0 }
    };

    // evaluate 的 eval 上下文没有 require：经 getBuiltinModule 自建
    // （基址取主进程入口，node_modules 解析到项目根）
    const { createRequire } = process.getBuiltinModule('module') as typeof import('module');
    const req = createRequire(process.cwd() + '/__req_base__.js');
    const { autoUpdater } = req('electron-updater') as typeof import('electron-updater');

    autoUpdater.quitAndInstall = () => {
      g.__upd.quit += 1;
    };
    (shell as unknown as { openExternal: (u: string) => void }).openExternal = (u: string) => {
      g.__upd.opened.push(u);
    };
    // 打桩函数在此定义（经 evaluate 传函数无法序列化——只传 JSON 配置）
    autoUpdater.checkForUpdates = (async () => {
      const cfg = g.__upd.check;
      if (cfg.delayMs > 0) await new Promise((r) => setTimeout(r, cfg.delayMs));
      if (cfg.mode === 'throw') throw new Error(cfg.errorMessage);
      if (cfg.mode === 'none') {
        return { isUpdateAvailable: false, updateInfo: { version: cfg.version } };
      }
      return {
        isUpdateAvailable: true,
        updateInfo: { version: cfg.version, releaseNotes: cfg.notes }
      };
    }) as unknown as typeof autoUpdater.checkForUpdates;
    autoUpdater.downloadUpdate = (() => {
      g.__upd.downloadCalls += 1;
      return new Promise(() => {});
    }) as unknown as typeof autoUpdater.downloadUpdate;

    const record = (opts: unknown): number => {
      const o = (opts ?? {}) as { message?: string; detail?: string; buttons?: string[] };
      g.__upd.dlgLog.push({
        message: String(o.message ?? ''),
        detail: String(o.detail ?? ''),
        buttons: o.buttons ?? []
      });
      return g.__upd.dlgQueue.shift() ?? 0;
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

/** 覆写 isPackaged：让 checkForUpdates 走真实状态机（e2e 属未打包环境） */
function forcePackaged(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ app: electronApp }) => {
    Object.defineProperty(electronApp, 'isPackaged', { get: () => true, configurable: true });
  });
}

function setCheckConfig(app: ElectronApplication, cfg: Partial<CheckConfig>): Promise<void> {
  return app.evaluate((_mods, c) => {
    Object.assign((globalThis as unknown as { __upd: UpdState }).__upd.check, c as CheckConfig);
  }, cfg as CheckConfig);
}

function queueDialogs(app: ElectronApplication, picks: number[]): Promise<void> {
  return app.evaluate((_mods, q) => {
    (globalThis as unknown as { __upd: UpdState }).__upd.dlgQueue.push(...(q as number[]));
  }, picks as number[]);
}

/** 主进程向 autoUpdater 单例派发事件（驱动下载生命周期） */
function emitUpdaterEvent(
  app: ElectronApplication,
  event: string,
  payload: unknown
): Promise<void> {
  return app.evaluate(
    (_mods, a) => {
      const { createRequire } = process.getBuiltinModule('module') as typeof import('module');
      const req = createRequire(process.cwd() + '/__req_base__.js');
      const { autoUpdater } = req('electron-updater') as typeof import('electron-updater');
      const { e, p } = a as { e: string; p: unknown };
      (autoUpdater as unknown as { emit: (ev: string, payload: unknown) => void }).emit(e, p);
    },
    { e: event, p: payload }
  );
}

/** 原生菜单「检查更新…」真实点击（click 处理器 → checkForUpdates(false)） */
function clickCheckUpdate(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
      for (const item of items) {
        if (item.label.startsWith('检查更新')) return item;
        if (item.submenu) {
          const hit = find(item.submenu.items);
          if (hit) return hit;
        }
      }
      return null;
    };
    find(Menu.getApplicationMenu()?.items ?? [])?.click();
  });
}

/** 弹框记录里匹配消息的条目 */
async function dlgByMessage(app: ElectronApplication, needle: string): Promise<DlgLogItem[]> {
  return (await updState(app)).dlgLog.filter((d) => d.message.includes(needle));
}

test('更新主流程：发现新版→下载中再检查→进度→就绪→稍后→再检查即安装', async () => {
  const handle: AppHandle = await launchApp();
  try {
    await installUpdStubs(handle.app);
    await forcePackaged(handle.app);
    // 保持"下载中"：downloadUpdate 桩返回 pending Promise，由测试驱动事件
    await setCheckConfig(handle.app, {
      mode: 'available',
      version: '9.9.9',
      notes: '<p>' + '更新说明正文' + '</p>'
    });
    // 对话框队列：①发现新版=0(下载) ②下载中=0(知道了) ③安装确认=1(稍后) ④安装确认=0(立即重启)
    await queueDialogs(handle.app, [0, 0, 1, 0]);

    // ① 发现新版弹框：HTML 发布说明被规整为纯文本
    await clickCheckUpdate(handle.app);
    await expect
      .poll(async () => (await dlgByMessage(handle.app, '发现新版本')).length, { timeout: 5000 })
      .toBe(1);
    const found = (await dlgByMessage(handle.app, '发现新版本'))[0];
    expect(found.detail).toContain('更新说明正文');
    expect(found.buttons).toEqual(['下载更新', '查看更新日志', '稍后提醒']);

    // ② 下载启动 → 转圈提示卡
    await expect(handle.window.locator('#update-download-panel')).toBeVisible({ timeout: 5000 });
    await expect(handle.window.locator('#update-download-panel .udp-meta')).toHaveText(
      /正在获取安装包/
    );

    // ③ 下载中再检查：告知进度、不重复下载
    await clickCheckUpdate(handle.app);
    await expect
      .poll(async () => (await dlgByMessage(handle.app, '正在下载')).length, { timeout: 5000 })
      .toBe(1);

    // ④ 进度事件 → 提示卡百分比
    await emitUpdaterEvent(handle.app, 'download-progress', {
      percent: 42,
      transferred: 42,
      total: 100,
      bytesPerSecond: 5
    });
    await expect(handle.window.locator('#update-download-panel .udp-bar')).toBeVisible({
      timeout: 5000
    });
    await expect(handle.window.locator('#update-download-panel .udp-meta')).toHaveText(/42%/);

    // ⑤ 下载完成 → 安装确认选「稍后」：不立即装
    await emitUpdaterEvent(handle.app, 'update-downloaded', { version: '9.9.9' });
    await expect
      .poll(async () => (await dlgByMessage(handle.app, '已下载完成')).length, { timeout: 5000 })
      .toBe(1);
    expect((await updState(handle.app)).quit).toBe(0);

    // ⑥ 就绪态再「检查更新」→ 直接再弹安装确认；选「立即重启安装」
    await clickCheckUpdate(handle.app);
    await expect
      .poll(async () => (await dlgByMessage(handle.app, '已下载完成')).length, { timeout: 5000 })
      .toBe(2);
    expect((await updState(handle.app)).quit).toBe(1);
  } finally {
    await closeApp(handle);
  }
});

test('更新流程：查看更新日志开发布页、之后不自动下载', async () => {
  const app = await launchApp();
  try {
    await installUpdStubs(app.app);
    await forcePackaged(app.app);
    await setCheckConfig(app.app, { mode: 'available', version: '9.9.9', notes: '' });
    await queueDialogs(app.app, [1]); // 查看更新日志
    await clickCheckUpdate(app.app);
    await expect
      .poll(async () => (await updState(app.app)).opened.length, { timeout: 5000 })
      .toBe(1);
    expect((await updState(app.app)).opened[0]).toContain('releases/tag/v9.9.9');
    expect((await updState(app.app)).downloadCalls).toBe(0);
  } finally {
    await closeApp(app);
  }
});

test('更新流程：取消下载 + 迟到 error 不弹框 + 关闭退出自动安装', async () => {
  const app = await launchApp();
  try {
    await installUpdStubs(app.app);
    await forcePackaged(app.app);
    await setCheckConfig(app.app, { mode: 'available', version: '9.9.9', notes: '' });
    await clickCheckUpdate(app.app);
    await expect(app.window.locator('#update-download-panel')).toBeVisible({ timeout: 5000 });

    // 点「取消下载」
    await app.window.locator('#update-download-panel .udp-btn').click();
    await expect(app.window.locator('#update-download-panel .udp-title')).toHaveText('已取消下载', {
      timeout: 5000
    });
    // 取消必须关掉"退出时自动安装"（否则取消后退出仍会装）
    const autoInstall = await app.app.evaluate(() => {
      const { createRequire } = process.getBuiltinModule('module') as typeof import('module');
      const req = createRequire(process.cwd() + '/__req_base__.js');
      const { autoUpdater } = req('electron-updater') as typeof import('electron-updater');
      return autoUpdater.autoInstallOnAppQuit;
    });
    expect(autoInstall).toBe(false);

    // 取消后迟到的 error 事件不得弹框
    await emitUpdaterEvent(app.app, 'error', new Error('canceled late'));
    await app.window.waitForTimeout(300);
    expect(await dlgByMessage(app.app, '更新下载失败')).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('更新流程：下载失败弹框（latest.yml 缺失的友好文案）', async () => {
  const app = await launchApp();
  try {
    await installUpdStubs(app.app);
    await forcePackaged(app.app);
    await setCheckConfig(app.app, { mode: 'available', version: '9.9.9', notes: '' });
    await clickCheckUpdate(app.app);
    await expect(app.window.locator('#update-download-panel')).toBeVisible({ timeout: 5000 });

    await emitUpdaterEvent(
      app.app,
      'error',
      new Error('Cannot find latest.yml in the latest release artifacts')
    );
    await expect
      .poll(async () => (await dlgByMessage(app.app, '更新下载失败')).length, { timeout: 5000 })
      .toBe(1);
    expect((await dlgByMessage(app.app, '更新下载失败'))[0].detail).toContain(
      '更新源缺少 latest.yml'
    );
  } finally {
    await closeApp(app);
  }
});

test('更新流程：已最新 / 检查失败（HttpError 头转储截断）', async () => {
  const app = await launchApp();
  try {
    await installUpdStubs(app.app);
    await forcePackaged(app.app);
    // 已最新
    await setCheckConfig(app.app, { mode: 'none', version: '1.0.0' });
    await clickCheckUpdate(app.app);
    await expect
      .poll(async () => (await dlgByMessage(app.app, '当前已是最新版本')).length, { timeout: 5000 })
      .toBe(1);

    // 检查失败：HttpError 消息的请求头转储被截掉
    await setCheckConfig(app.app, {
      mode: 'throw',
      errorMessage: 'HTTP 500\n\nmethod: GET https://x\nHeaders: {...}'
    });
    await clickCheckUpdate(app.app);
    await expect
      .poll(async () => (await dlgByMessage(app.app, '检查更新失败')).length, { timeout: 5000 })
      .toBe(1);
    const failed = (await dlgByMessage(app.app, '检查更新失败'))[0];
    expect(failed.detail).toContain('HTTP 500');
    expect(failed.detail).not.toContain('Headers:');
  } finally {
    await closeApp(app);
  }
});

test('手动检查更新：先显示「正在检查更新」提示卡，出结果后收起', async () => {
  const app = await launchApp();
  try {
    await installUpdStubs(app.app);
    await forcePackaged(app.app);
    // 检查耗时 1.5s：给提示卡留可断言窗口（真实网络往返即此窗口）
    await setCheckConfig(app.app, { mode: 'none', version: '1.0.0', delayMs: 1500 });
    await queueDialogs(app.app, [0]);

    await clickCheckUpdate(app.app);
    await expect(app.window.locator('#update-download-panel')).toBeVisible({ timeout: 5000 });
    await expect(app.window.locator('#update-download-panel .udp-title')).toHaveText('检查更新');
    await expect(app.window.locator('#update-download-panel .udp-meta')).toHaveText(/正在检查更新/);
    // 检查期取消下载按钮不出现（检查不可取消）
    await expect(app.window.locator('#update-download-panel .udp-btn')).toBeHidden();

    // 结果弹框出现（已最新）→ 提示卡收起（不是停 8 秒自动收，而是立刻收）
    await expect
      .poll(async () => (await dlgByMessage(app.app, '当前已是最新版本')).length, {
        timeout: 5000
      })
      .toBe(1);
    await expect(app.window.locator('#update-download-panel')).toBeHidden({ timeout: 5000 });
  } finally {
    await closeApp(app);
  }
});

test('更新守卫：未打包环境手动检查提示开发模式（不触网）', async () => {
  const app = await launchApp();
  try {
    // 不覆写 isPackaged：真实 dev/e2e 短路路径
    await installUpdStubs(app.app);
    await clickCheckUpdate(app.app);
    await expect
      .poll(async () => (await dlgByMessage(app.app, '开发模式下不检查更新')).length, {
        timeout: 5000
      })
      .toBe(1);
  } finally {
    await closeApp(app);
  }
});
