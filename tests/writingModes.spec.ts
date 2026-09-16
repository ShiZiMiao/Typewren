import { test, expect } from '@playwright/test';
import { closeApp, launchApp, loadContent, sendCommand, type AppHandle } from './helpers';

let app: AppHandle;

test.beforeAll(async () => {
  app = await launchApp();
  // 清理可能残留的模式状态（前一次运行写入的 localStorage 会污染本次）
  await app.window.evaluate(() => {
    localStorage.removeItem('typewren.focus-mode');
    localStorage.removeItem('typewren.typewriter-mode');
  });
  await app.window.reload();
  await app.window.waitForSelector('.ProseMirror', { timeout: 15000 });
  await app.window.waitForTimeout(400);
});

test.afterAll(async () => {
  await closeApp(app);
});

/** 确保模式处于关闭态（幂等） */
async function ensureOff(key: string, cmd: string): Promise<void> {
  const on = await app.window.evaluate((k) => localStorage.getItem(k) === '1', key);
  if (on) await sendCommand(app, cmd);
  await app.window.waitForTimeout(150);
}

test.describe('写作模式', () => {
  test('焦点模式：当前块高亮、其余淡化', async () => {
    await ensureOff('typewren.focus-mode', 'view:focus-mode');
    const md = '# 标题\n\n第一段内容。\n\n第二段内容。\n';
    await loadContent(app, md);
    // 光标点到第二段
    await app.window.locator('.ProseMirror p').nth(1).click();
    await app.window.waitForTimeout(200);

    await sendCommand(app, 'view:focus-mode');
    await app.window.waitForTimeout(300);
    const state = await app.window.evaluate(() => ({
      on: document.querySelector('.ProseMirror')?.classList.contains('focus-mode') ?? false,
      focusedBlocks: document.querySelectorAll('.focused-block').length,
      focusedText: document.querySelector('.focused-block')?.textContent ?? ''
    }));
    expect(state.on).toBe(true);
    expect(state.focusedBlocks).toBe(1);
    expect(state.focusedText).toContain('第二段');

    // 关闭后清理
    await sendCommand(app, 'view:focus-mode');
    await app.window.waitForTimeout(200);
    const off = await app.window.evaluate(() => document.querySelectorAll('.focused-block').length);
    expect(off).toBe(0);
  });

  test('打字机模式：光标保持编辑区中部', async () => {
    await ensureOff('typewren.typewriter-mode', 'view:typewriter-mode');
    const md = Array.from({ length: 40 }, (_, i) => `第${i + 1}段内容。`).join('\n\n');
    await loadContent(app, md);
    await app.window.locator('.ProseMirror p').last().click();
    await app.window.waitForTimeout(300);

    await sendCommand(app, 'view:typewriter-mode');
    await app.window.waitForTimeout(500);

    const pos = await app.window.evaluate(() => {
      const container = document.getElementById('editor-container');
      const sel = window.getSelection();
      if (!container || !sel || sel.rangeCount === 0) return null;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      const cr = container.getBoundingClientRect();
      return { relative: (r.top - cr.top) / cr.height, scrollTop: container.scrollTop };
    });
    // 光标应在视口中部附近（0.5 ± 0.15）
    expect(pos).not.toBeNull();
    expect(pos!.relative).toBeGreaterThan(0.3);
    expect(pos!.relative).toBeLessThan(0.7);
    // 文档较长，容器确已滚动
    expect(pos!.scrollTop).toBeGreaterThan(0);

    await sendCommand(app, 'view:typewriter-mode');
  });
});
