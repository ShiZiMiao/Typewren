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
    const state = await app.window.evaluate(() => {
      // 隐藏窗口（--test）下 CSS transition 被 Chromium 冻结，opacity 恒为起始值；
      // 取消过渡再测量，验证淡化规则真实生效（曾因选择器写错永不高亮）
      const pm = document.querySelector('.ProseMirror') as HTMLElement;
      for (const el of Array.from(pm.children) as HTMLElement[]) el.style.transition = 'none';
      void pm.offsetHeight;
      return {
        on: pm.classList.contains('focus-mode'),
        focusedBlocks: document.querySelectorAll('.focused-block').length,
        focusedText: document.querySelector('.focused-block')?.textContent ?? '',
        otherOpacity: parseFloat(
          getComputedStyle(document.querySelector('.ProseMirror > p') as HTMLElement).opacity
        ),
        focusedOpacity: parseFloat(
          getComputedStyle(document.querySelector('.focused-block') as HTMLElement).opacity
        )
      };
    });
    expect(state.on).toBe(true);
    expect(state.focusedBlocks).toBe(1);
    expect(state.focusedText).toContain('第二段');
    expect(state.otherOpacity).toBeLessThan(0.9);
    expect(state.focusedOpacity).toBeGreaterThan(0.9);

    // 关闭后清理
    await sendCommand(app, 'view:focus-mode');
    await app.window.waitForTimeout(200);
    const off = await app.window.evaluate(() => ({
      blocks: document.querySelectorAll('.focused-block').length
    }));
    expect(off.blocks).toBe(0);
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

  test('焦点模式：光标在表格内时整表为焦点块（不整表淡化）', async () => {
    await ensureOff('typewren.focus-mode', 'view:focus-mode');
    const md = '# 标题\n\n| 列A | 列B |\n| --- | --- |\n| 甲 | 乙 |\n\n第一段。\n';
    await loadContent(app, md);
    await app.window.locator('.ProseMirror td').first().click();
    await app.window.waitForTimeout(200);

    await sendCommand(app, 'view:focus-mode');
    await app.window.waitForTimeout(300);
    const state = await app.window.evaluate(() => {
      const pm = document.querySelector('.ProseMirror') as HTMLElement;
      for (const el of Array.from(pm.children) as HTMLElement[]) el.style.transition = 'none';
      void pm.offsetHeight;
      return {
        focusedWrappers: document.querySelectorAll('.table-scroll-wrapper.focused-block').length,
        wrapperOpacity: parseFloat(
          getComputedStyle(document.querySelector('.table-scroll-wrapper') as HTMLElement).opacity
        ),
        otherOpacity: parseFloat(
          getComputedStyle(document.querySelector('.ProseMirror > p') as HTMLElement).opacity
        )
      };
    });
    expect(state.focusedWrappers).toBe(1);
    expect(state.wrapperOpacity).toBeGreaterThan(0.9);
    expect(state.otherOpacity).toBeLessThan(0.9);

    await sendCommand(app, 'view:focus-mode');
    await app.window.waitForTimeout(150);
  });

  test('焦点模式：光标在引用块内时整块引用为焦点块（曾整体淡化）', async () => {
    await ensureOff('typewren.focus-mode', 'view:focus-mode');
    const md = '# 标题\n\n> 引用第一行。\n> 引用第二行。\n\n正文末尾。\n';
    await loadContent(app, md);
    await app.window.locator('.ProseMirror blockquote').click();
    await app.window.waitForTimeout(200);

    await sendCommand(app, 'view:focus-mode');
    await app.window.waitForTimeout(300);
    const state = await app.window.evaluate(() => {
      const pm = document.querySelector('.ProseMirror') as HTMLElement;
      for (const el of Array.from(pm.children) as HTMLElement[]) el.style.transition = 'none';
      void pm.offsetHeight;
      return {
        focusedQuotes: document.querySelectorAll('blockquote.focused-block').length,
        quoteOpacity: parseFloat(
          getComputedStyle(document.querySelector('.ProseMirror > blockquote') as HTMLElement)
            .opacity
        ),
        otherOpacity: parseFloat(
          getComputedStyle(document.querySelector('.ProseMirror > p') as HTMLElement).opacity
        )
      };
    });
    expect(state.focusedQuotes).toBe(1);
    expect(state.quoteOpacity).toBeGreaterThan(0.9);
    expect(state.otherOpacity).toBeLessThan(0.9);

    await sendCommand(app, 'view:focus-mode');
    await app.window.waitForTimeout(150);
  });

  test('焦点模式：光标在列表项内时顶层列表为焦点块（不整列表淡化）', async () => {
    await ensureOff('typewren.focus-mode', 'view:focus-mode');
    const md = '# 标题\n\n- 列表A\n- 列表B\n\n正文结尾。\n';
    await loadContent(app, md);
    await app.window.locator('.ProseMirror li').first().click();
    await app.window.waitForTimeout(200);

    await sendCommand(app, 'view:focus-mode');
    await app.window.waitForTimeout(300);
    const state = await app.window.evaluate(() => {
      const pm = document.querySelector('.ProseMirror') as HTMLElement;
      for (const el of Array.from(pm.children) as HTMLElement[]) el.style.transition = 'none';
      void pm.offsetHeight;
      return {
        focusedLists: document.querySelectorAll('.ProseMirror > ul.focused-block').length,
        listOpacity: parseFloat(
          getComputedStyle(document.querySelector('.ProseMirror > ul') as HTMLElement).opacity
        ),
        otherOpacity: parseFloat(
          getComputedStyle(document.querySelector('.ProseMirror > p') as HTMLElement).opacity
        )
      };
    });
    expect(state.focusedLists).toBe(1);
    expect(state.listOpacity).toBeGreaterThan(0.9);
    expect(state.otherOpacity).toBeLessThan(0.9);

    await sendCommand(app, 'view:focus-mode');
    await app.window.waitForTimeout(150);
  });

  test('焦点模式：模式类被清除后随下一次视图更新自动恢复', async () => {
    await ensureOff('typewren.focus-mode', 'view:focus-mode');
    await loadContent(app, '第一段。\n\n第二段。\n');
    await sendCommand(app, 'view:focus-mode');
    await app.window.waitForTimeout(200);

    // 模拟外部操作把 view.dom 上的 focus-mode 类抹掉（历史缺陷：仅 toggle 时加类）
    const removed = await app.window.evaluate(() => {
      document.querySelector('.ProseMirror')?.classList.remove('focus-mode');
      return document.querySelector('.ProseMirror')?.classList.contains('focus-mode');
    });
    expect(removed).toBe(false);

    await app.window.locator('.ProseMirror > p').first().click();
    await app.window.keyboard.type('x');
    await app.window.waitForTimeout(200);
    expect(
      await app.window.evaluate(() =>
        document.querySelector('.ProseMirror')?.classList.contains('focus-mode')
      )
    ).toBe(true);

    await sendCommand(app, 'view:focus-mode');
  });
});
