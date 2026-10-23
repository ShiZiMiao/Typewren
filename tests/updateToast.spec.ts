import { test, expect } from '@playwright/test';
import { launchApp, closeApp } from './helpers';

/* ============================================================
 * 更新提示卡状态切换回归：
 * starting（正在获取安装包）→ 转圈图标、无进度条；
 * 首个 download-progress → 切回进度条。
 * dev/--test 下真实更新流无法触发（checkForUpdates 对未打包直接
 * 返回），经 app.evaluate 伪造 updater:download-state 驱动渲染层
 * （同 loadContent 的主进程注入模式）。
 * ============================================================ */

test('获取安装包阶段显示转圈、下载阶段显示进度条', async () => {
  const { app, window } = await launchApp();
  try {
    const panel = window.locator('#update-download-panel');

    // starting：尚无进度数据 → 转圈、进度条隐藏、「取消下载」仍可用
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('updater:download-state', {
        phase: 'starting',
        version: '9.9.9'
      });
    });
    await expect(panel).toBeVisible();
    await expect(panel.locator('.udp-spinner')).toBeVisible();
    await expect(panel.locator('.udp-bar')).toBeHidden();
    await expect(panel.locator('.udp-meta')).toHaveText(/正在获取安装包/);
    await expect(panel.locator('.udp-btn')).toBeVisible();

    // progress：首个真实进度 → 进度条、转圈消失
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('updater:download-state', {
        phase: 'progress',
        version: '9.9.9',
        percent: 42,
        transferred: 42e6,
        total: 100e6,
        bytesPerSecond: 5e6
      });
    });
    await expect(panel.locator('.udp-spinner')).toBeHidden();
    await expect(panel.locator('.udp-bar')).toBeVisible();
    await expect(panel.locator('.udp-meta')).toHaveText(/42% · 42\.0 MB \/ 100 MB · 5\.0 MB\/s/);
    // 断言内联 style 而非 computed width：无头下 CSS transition 冻结在起始值
    await expect(panel.locator('.udp-fill')).toHaveAttribute('style', /width:\s*42%/);
  } finally {
    await closeApp({ app, window });
  }
});
