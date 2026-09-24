import { test, expect } from '@playwright/test';
import { launchApp, closeApp, loadContent, type AppHandle } from './helpers';

/* ============================================================
 * 搜索栏（Ctrl+F 查找 / Ctrl+H 替换）e2e
 * 启动/内容注入走 helpers（统一 --test + 隔离 user-data-dir + 对话框桩）。
 * ============================================================ */

let app: AppHandle;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await closeApp(app);
});

async function ensureSearchClosed(): Promise<void> {
  const searchBar = app.window.locator('#search-bar');
  if (await searchBar.isVisible()) {
    // Ctrl+F 切换关闭搜索栏（Escape 只在输入框有焦点时生效）
    await app.window.keyboard.press('Control+f');
    await expect(searchBar).toBeHidden();
  }
}

/**
 * 用真实输入覆盖编辑器内容。
 * 全选用 DOM 选区（PM 经 selectionchange 同步 state.selection）——
 * 不用键盘 Ctrl+A：CI 无焦点窗口下键盘事件不可靠（同 actions.spec 注释）。
 */
async function setEditorContent(text: string): Promise<void> {
  await app.window.locator('.ProseMirror').click();
  await app.window.evaluate(() => {
    const pm = document.querySelector('.ProseMirror') as HTMLElement;
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(pm);
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
  await app.window.waitForFunction(() => (window.getSelection()?.toString().length ?? 0) > 0);
  // 输入覆盖选区（不再单独 Delete 清空）
  await app.window.keyboard.type(text);
  await app.window.waitForTimeout(300);
}

// ========== 搜索功能 ==========

test.describe('搜索功能', () => {
  test.beforeEach(async () => {
    await ensureSearchClosed();
  });

  test('搜索匹配计数正确', async () => {
    await setEditorContent('hello world hello test hello');
    await app.window.keyboard.press('Control+f');
    await app.window.locator('#search-input').fill('hello');
    await app.window.waitForTimeout(500);
    await expect(app.window.locator('#search-match-count')).toHaveText('1/3');
  });

  test('Enter 导航下一个', async () => {
    await setEditorContent('hello world hello test hello');
    await app.window.keyboard.press('Control+f');
    await app.window.locator('#search-input').fill('hello');
    await app.window.waitForTimeout(500);
    await expect(app.window.locator('#search-match-count')).toHaveText('1/3');

    await app.window.locator('#search-input').click();
    await app.window.keyboard.press('Enter');
    await app.window.waitForTimeout(300);
    await expect(app.window.locator('#search-match-count')).toHaveText('2/3');

    await app.window.keyboard.press('Enter');
    await app.window.waitForTimeout(300);
    await expect(app.window.locator('#search-match-count')).toHaveText('3/3');

    await app.window.keyboard.press('Enter');
    await app.window.waitForTimeout(300);
    await expect(app.window.locator('#search-match-count')).toHaveText('1/3');
  });

  test('Shift+Enter 导航上一个', async () => {
    await setEditorContent('hello world hello test hello');
    await app.window.keyboard.press('Control+f');
    await app.window.locator('#search-input').fill('hello');
    await app.window.waitForTimeout(500);

    await app.window.locator('#search-input').click();
    await app.window.keyboard.press('Shift+Enter');
    await app.window.waitForTimeout(300);
    await expect(app.window.locator('#search-match-count')).toHaveText('3/3');
  });

  test('点击按钮导航', async () => {
    await setEditorContent('hello world hello test hello');
    await app.window.keyboard.press('Control+f');
    await app.window.locator('#search-input').fill('hello');
    await app.window.waitForTimeout(500);

    await app.window.locator('#search-next').click();
    await app.window.waitForTimeout(300);
    await expect(app.window.locator('#search-match-count')).toHaveText('2/3');

    await app.window.locator('#search-prev').click();
    await app.window.waitForTimeout(300);
    await expect(app.window.locator('#search-match-count')).toHaveText('1/3');
  });
});

// ========== 替换功能 ==========

test.describe('替换功能', () => {
  test.beforeEach(async () => {
    await ensureSearchClosed();
  });

  test('Ctrl+H 打开替换面板', async () => {
    await setEditorContent('test');
    await app.window.keyboard.press('Control+h');
    await expect(app.window.locator('#search-bar')).toBeVisible();
    await expect(app.window.locator('#replace-row')).toBeVisible();
    await expect(app.window.locator('#replace-input')).toBeVisible();
  });

  test('替换当前匹配', async () => {
    await setEditorContent('hello world hello test hello');
    await app.window.keyboard.press('Control+h');
    await app.window.locator('#search-input').fill('hello');
    await app.window.locator('#replace-input').fill('hi');
    await app.window.waitForTimeout(500);

    await expect(app.window.locator('#search-match-count')).toHaveText('1/3');

    await app.window.locator('#btn-replace').click();
    await app.window.waitForTimeout(500);

    const text = await app.window.locator('.ProseMirror').textContent();
    expect(text).toBe('hi world hello test hello');
  });

  test('全部替换', async () => {
    await setEditorContent('hello world hello test hello');
    await app.window.keyboard.press('Control+h');
    await app.window.locator('#search-input').fill('hello');
    await app.window.locator('#replace-input').fill('hi');
    await app.window.waitForTimeout(500);

    await app.window.locator('#btn-replace-all').click();
    await app.window.waitForTimeout(500);

    const text = await app.window.locator('.ProseMirror').textContent();
    expect(text).toBe('hi world hi test hi');
  });

  test('替换撤销', async () => {
    await setEditorContent('hello world hello test hello');
    await app.window.keyboard.press('Control+h');
    await app.window.locator('#search-input').fill('hello');
    await app.window.locator('#replace-input').fill('hi');
    await app.window.waitForTimeout(500);

    await app.window.locator('#btn-replace').click();
    await app.window.waitForTimeout(500);

    let text = await app.window.locator('.ProseMirror').textContent();
    expect(text).toBe('hi world hello test hello');

    await app.window.locator('.ProseMirror').click();
    await app.window.keyboard.press('Control+z');
    await app.window.waitForTimeout(500);

    text = await app.window.locator('.ProseMirror').textContent();
    expect(text).toBe('hello world hello test hello');
  });

  test('全部替换撤销', async () => {
    await setEditorContent('hello world hello test hello');
    await app.window.keyboard.press('Control+h');
    await app.window.locator('#search-input').fill('hello');
    await app.window.locator('#replace-input').fill('hi');
    await app.window.waitForTimeout(500);

    await app.window.locator('#btn-replace-all').click();
    await app.window.waitForTimeout(500);

    let text = await app.window.locator('.ProseMirror').textContent();
    expect(text).toBe('hi world hi test hi');

    await app.window.locator('.ProseMirror').click();
    await app.window.keyboard.press('Control+z');
    await app.window.waitForTimeout(500);

    text = await app.window.locator('.ProseMirror').textContent();
    expect(text).toBe('hello world hello test hello');
  });
});

// ========== 搜索扩展（补充用例） ==========

test.describe('搜索扩展', () => {
  test.beforeEach(async () => {
    await ensureSearchClosed();
  });

  test('无匹配显示 0/0', async () => {
    await setEditorContent('ababab');
    await app.window.keyboard.press('Control+f');
    await app.window.locator('#search-input').fill('zzz不存在');
    await app.window.waitForTimeout(500);
    await expect(app.window.locator('#search-match-count')).toHaveText('0/0');
  });

  test('跨段内容匹配', async () => {
    await setEditorContent('第一段内容 hello\n\n第二段 hello world');
    await app.window.keyboard.press('Control+f');
    await app.window.locator('#search-input').fill('hello');
    await app.window.waitForTimeout(500);
    await expect(app.window.locator('#search-match-count')).toHaveText('1/2');
  });

  test('替换后文档置脏', async () => {
    await setEditorContent('hello world');
    await app.window.keyboard.press('Control+h');
    await app.window.locator('#search-input').fill('hello');
    await app.window.locator('#replace-input').fill('hi');
    await app.window.waitForTimeout(500);
    await app.window.locator('#btn-replace').click();
    await app.window.waitForTimeout(300);
    await expect(app.window.locator('#titlebar-title')).toContainText('●');
  });

  test('Esc 关闭搜索栏且不破坏文档', async () => {
    await setEditorContent('hello world');
    await app.window.keyboard.press('Control+f');
    await app.window.locator('#search-input').fill('hello');
    await app.window.waitForTimeout(300);
    await app.window.locator('#search-input').press('Escape');
    await expect(app.window.locator('#search-bar')).toBeHidden();
    await expect(app.window.locator('.ProseMirror')).toContainText('hello world');
  });
});

// ========== 回归 ==========

test.describe('回归：匹配/替换语义与 Ctrl+H 状态机', () => {
  test.beforeEach(async () => {
    await ensureSearchClosed();
  });

  test('重叠匹配按非重叠推进（aa/aaaa 记 2 处且替换口径一致）', async () => {
    // 旧实现 doHighlight pos=idx+1 允许重叠（记 3 处），替换却按 +keyword.length
    // 非重叠推进（只替 2 处）——计数与替换对不上；渲染模式全部替换还会因
    // 重叠区间反向 insertText 互相踩踏破坏正文
    await setEditorContent('aaaa');
    await app.window.keyboard.press('Control+h');
    await app.window.locator('#search-input').fill('aa');
    await app.window.waitForTimeout(500);
    await expect(app.window.locator('#search-match-count')).toHaveText('1/2');

    await app.window.locator('#replace-input').fill('b');
    await app.window.locator('#btn-replace-all').click();
    await app.window.waitForTimeout(500);
    expect(await app.window.locator('.ProseMirror').textContent()).toBe('bb');
    await expect(app.window.locator('#search-match-count')).toContainText('已替换 2 处');
  });

  test('连按两次 Ctrl+H 状态正确（幂等打开，不关掉再藏）', async () => {
    // 旧实现 edit:replace = toggle()+toggleReplace()：替换面板已开时先整个
    // 关掉、再把 replace 行显示在隐藏容器里——状态直接错乱
    await setEditorContent('hello');
    await app.window.keyboard.press('Control+h');
    await app.window.keyboard.press('Control+h');
    await expect(app.window.locator('#search-bar')).toBeVisible();
    await expect(app.window.locator('#replace-row')).toBeVisible();
    await expect(app.window.locator('#replace-input')).toBeVisible();

    // 计数仍工作（搜索栏真实可用）
    await app.window.locator('#search-input').fill('h');
    await app.window.waitForTimeout(400);
    await expect(app.window.locator('#search-match-count')).toHaveText('1/1');
  });

  test('文档变更后替换不抛错（陈旧 Range 防护 + 变更重扫）', async () => {
    const pageErrors: string[] = [];
    const collect = (err: Error): void => {
      pageErrors.push(String(err));
    };
    app.window.on('pageerror', collect);
    try {
      await setEditorContent('hello world');
      await app.window.keyboard.press('Control+h');
      await app.window.locator('#search-input').fill('hello');
      await app.window.locator('#replace-input').fill('hi');
      await app.window.waitForTimeout(400);

      // 整文档替换 → PM 重建 DOM，此前收集的 Range 全部陈旧
      //（旧代码点「替换」即 posAtDOM 抛 RangeError 打断，或替换错位）
      await loadContent(app, 'hello world again');
      await app.window.locator('#btn-replace').click();
      await app.window.waitForTimeout(500);

      expect(await app.window.locator('.ProseMirror').textContent()).toBe('hi world again');
      expect(pageErrors).toEqual([]);
    } finally {
      app.window.off('pageerror', collect);
    }
  });
});
