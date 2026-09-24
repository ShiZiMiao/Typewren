import { test, expect } from '@playwright/test';
import { ZOOM_PERCENT_MAX, ZOOM_PERCENT_MIN } from '../src/shared/zoomKeys';
import { launchApp, closeApp, sendCommand, type AppHandle } from './helpers';

/* ============================================================
 * 内容区缩放（只缩放编辑/源码区域，UI 骨架不动；断言 CSS 变量 --content-zoom）
 * 每步 10 个百分点——若快捷键双触发（抢占层 + 渲染层）会变 20，
 * 断言恰好 110 即失败，兼作"不双触发"回归。
 * ============================================================ */

let app: AppHandle;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await closeApp(app);
});

/** 当前内容区缩放百分比（根元素 CSS 变量 --content-zoom） */
function zoomPercent(): Promise<number> {
  return app.window.evaluate(() => {
    const v = document.documentElement.style.getPropertyValue('--content-zoom') || '1';
    return Math.round(parseFloat(v) * 100);
  });
}

/** 重置缩放基线（菜单命令路径） */
async function resetZoom(): Promise<void> {
  await sendCommand(app, 'view:zoom-reset');
  await app.window.waitForTimeout(120);
}

test.describe('内容区缩放', () => {
  test.beforeEach(async () => {
    await resetZoom();
  });

  test('Ctrl+= 放大、Ctrl+- 缩小（步进 10%）', async () => {
    expect(await zoomPercent()).toBe(100);

    await app.window.keyboard.press('Control+=');
    await app.window.waitForTimeout(120);
    expect(await zoomPercent()).toBe(110);

    await app.window.keyboard.press('Control+-');
    await app.window.waitForTimeout(120);
    expect(await zoomPercent()).toBe(100);
  });

  test('Ctrl++（Ctrl+Shift+=）同样放大', async () => {
    await app.window.keyboard.press('Control+Shift+=');
    await app.window.waitForTimeout(120);
    expect(await zoomPercent()).toBe(110);
  });

  test('重置缩放 Ctrl+Shift+D；裸 Ctrl+0 不是缩放', async () => {
    await app.window.keyboard.press('Control+=');
    await app.window.keyboard.press('Control+=');
    await app.window.waitForTimeout(120);
    expect(await zoomPercent()).toBe(120);

    await app.window.keyboard.press('Control+Shift+D');
    await app.window.waitForTimeout(120);
    expect(await zoomPercent()).toBe(100);

    // 裸 Ctrl+0 保留给段落→正文，不改缩放
    await app.window.keyboard.press('Control+=');
    await app.window.waitForTimeout(120);
    expect(await zoomPercent()).toBe(110);
    await app.window.keyboard.press('Control+0');
    await app.window.waitForTimeout(120);
    expect(await zoomPercent()).toBe(110);

    // 备用判定 Ctrl+Shift+0 仍生效（菜单不显示，系统/输入法未占用时可用）
    await app.window.keyboard.press('Control+Shift+0');
    await app.window.waitForTimeout(120);
    expect(await zoomPercent()).toBe(100);
  });

  test('缩放有上下限：连击到 300% / 50% 后钳制不再变化', async () => {
    // 步进 10%：100→300 / 300→50 各需 20/25 次，取 30 次保证过冲
    for (let i = 0; i < 30; i++) await sendCommand(app, 'view:zoom-in');
    await app.window.waitForTimeout(250);
    expect(await zoomPercent()).toBe(ZOOM_PERCENT_MAX);

    // 到顶后再按快捷键（同一收口）→ 仍不动
    await app.window.keyboard.press('Control+=');
    await app.window.waitForTimeout(120);
    expect(await zoomPercent()).toBe(ZOOM_PERCENT_MAX);

    for (let i = 0; i < 30; i++) await sendCommand(app, 'view:zoom-out');
    await app.window.waitForTimeout(250);
    expect(await zoomPercent()).toBe(ZOOM_PERCENT_MIN);

    await app.window.keyboard.press('Control+-');
    await app.window.waitForTimeout(120);
    expect(await zoomPercent()).toBe(ZOOM_PERCENT_MIN);

    // reset 不受边界影响
    await sendCommand(app, 'view:zoom-reset');
    await app.window.waitForTimeout(120);
    expect(await zoomPercent()).toBe(100);
  });

  test('菜单命令路径（cmd → commandRouter）同效', async () => {
    await sendCommand(app, 'view:zoom-in');
    await app.window.waitForTimeout(120);
    expect(await zoomPercent()).toBe(110);

    await sendCommand(app, 'view:zoom-out');
    await app.window.waitForTimeout(120);
    expect(await zoomPercent()).toBe(100);

    await sendCommand(app, 'view:zoom-in');
    await sendCommand(app, 'view:zoom-in');
    await app.window.waitForTimeout(120);
    expect(await zoomPercent()).toBe(120);

    await sendCommand(app, 'view:zoom-reset');
    await app.window.waitForTimeout(120);
    expect(await zoomPercent()).toBe(100);
  });

  test('Ctrl+滚轮：一格恰好步进 10%（不双触发），普通滚轮不动', async () => {
    await app.window.keyboard.down('Control');
    await app.window.mouse.move(400, 300);
    await app.window.mouse.wheel(0, -100);
    await app.window.keyboard.up('Control');
    await app.window.waitForTimeout(120);
    expect(await zoomPercent()).toBe(110);

    await app.window.keyboard.down('Control');
    await app.window.mouse.wheel(0, 100);
    await app.window.keyboard.up('Control');
    await app.window.waitForTimeout(120);
    expect(await zoomPercent()).toBe(100);

    // 无 Ctrl 的普通滚轮：不缩放、且不吞默认滚动
    const plainPrevented = await app.window.evaluate(() => {
      const ev = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(plainPrevented).toBe(false);
    expect(await zoomPercent()).toBe(100);
  });

  test('真实键路径（webContents 输入 → before-input 抢占层）Ctrl+Shift+D 重置', async () => {
    await app.window.keyboard.press('Control+=');
    await app.window.keyboard.press('Control+=');
    await app.window.waitForTimeout(150);
    expect(await zoomPercent()).toBe(120);

    // 经 webContents.sendInputEvent 走真实输入管线（非 DOM 合成），
    // 覆盖主进程 before-input-event 抢占层（真实按键的菜单吞键问题即在此层修）
    await app.app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'D', modifiers: ['shift', 'control'] });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'D', modifiers: ['shift', 'control'] });
    });
    await app.window.waitForTimeout(150);
    expect(await zoomPercent()).toBe(100);
  });

  test('Ctrl+滚轮小增量累计步进；每个事件都被 preventDefault', async () => {
    const fire = (deltaY: number): Promise<boolean> =>
      app.window.evaluate((dy) => {
        const ev = new WheelEvent('wheel', {
          deltaY: dy,
          deltaMode: 0,
          ctrlKey: true,
          bubbles: true,
          cancelable: true
        });
        document.body.dispatchEvent(ev);
        return ev.defaultPrevented;
      }, deltaY);

    // 两次 -15 累计 30 < 40 不步进，但默认行为照常被吞
    expect(await fire(-15)).toBe(true);
    expect(await fire(-15)).toBe(true);
    expect(await zoomPercent()).toBe(100);

    // 第三次越过阈值 → 步进 10%
    expect(await fire(-15)).toBe(true);
    await app.window.waitForTimeout(120);
    expect(await zoomPercent()).toBe(110);
  });

  test('页面级缩放归一：遗留整页缩放被强制清零（防整体 UI 偏小）', async () => {
    // 模拟旧版整页缩放的遗留值（负 zoomLevel）
    await app.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.setZoomLevel(-2);
    });
    await app.window.waitForTimeout(120);

    // 重新导航 → did-finish-load 归一逻辑清零（并改写该域名的持久化值）
    await app.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.reload();
    });
    await app.window.waitForSelector('.ProseMirror', { timeout: 15000 });
    await app.window.waitForTimeout(400);

    const level = await app.app.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows()[0].webContents.getZoomLevel();
    });
    expect(level).toBeCloseTo(0, 5);
  });

  test('只缩放内容区：UI 骨架尺寸不变、内容实际放大', async () => {
    const metrics = async (): Promise<{
      titlebar: number;
      side: number;
      statusbar: number;
      contentZoom: number;
    }> =>
      app.window.evaluate(() => {
        const height = (sel: string): number => {
          const el = document.querySelector(sel);
          return el ? Math.round(el.getBoundingClientRect().height * 10) / 10 : -1;
        };
        const side = document.querySelector('#side-panel');
        const pm = document.querySelector('.ProseMirror');
        // CSS zoom 不改 computed font-size（局部单位）；实际渲染缩放 =
        // 屏幕 rect 宽 ÷ 局部 clientWidth
        const contentZoom =
          pm && pm.clientWidth > 0
            ? Math.round((pm.getBoundingClientRect().width / pm.clientWidth) * 100) / 100
            : -1;
        return {
          titlebar: height('#titlebar'),
          side: side ? Math.round(side.getBoundingClientRect().width * 10) / 10 : -1,
          statusbar: height('#status-bar'),
          contentZoom
        };
      });

    const before = await metrics();
    await app.window.keyboard.press('Control+=');
    await app.window.keyboard.press('Control+=');
    await app.window.waitForTimeout(150);
    const after = await metrics();
    expect(await zoomPercent()).toBe(120);

    // UI 骨架（标题栏 / 侧栏 / 状态栏）不受内容区缩放影响
    expect(after.titlebar).toBe(before.titlebar);
    expect(after.side).toBe(before.side);
    expect(after.statusbar).toBe(before.statusbar);
    // 编辑区内容实际放大（rect/clientWidth 比值 ×1.2）
    expect(after.contentZoom / before.contentZoom).toBeCloseTo(1.2, 1);
  });
});
