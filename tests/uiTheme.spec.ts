import { test, expect } from '@playwright/test';
import { launchApp, closeApp, loadContent, sendCommand, type AppHandle } from './helpers';

let app: AppHandle;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await closeApp(app);
});

async function readTheme(): Promise<string> {
  return app.window.evaluate(() => document.documentElement.dataset.theme ?? 'light');
}

/** 状态栏按钮无 id，用 title 定位主题切换按钮（标题随主题变化，含"主题"关键字） */
const themeButton = (): ReturnType<typeof app.window.locator> =>
  app.window.locator('#status-bar button[title*="主题"]');

test.describe('主题切换', () => {
  test('按钮切换亮/暗主题且 DOM 同步', async () => {
    const before = await readTheme();
    await themeButton().click();
    await app.window.waitForTimeout(400);

    const now = await readTheme();
    expect(now).not.toBe(before);
    expect(['light', 'dark']).toContain(now);
  });

  test('view:theme 命令切换并持久化偏好', async () => {
    const before = await readTheme();
    await sendCommand(app, 'view:theme');
    await app.window.waitForTimeout(400);
    const now = await readTheme();
    expect(now).not.toBe(before);

    const stored = await app.window.evaluate(() => localStorage.getItem('typewren.theme'));
    expect(stored === 'light' || stored === 'dark').toBe(true);
  });

  test('主题变量随 data-theme 变化', async () => {
    const getVar = (): Promise<string> =>
      app.window.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return (
          style.getPropertyValue('--bg-strong').trim() || style.getPropertyValue('--bg-soft').trim()
        );
      });
    const before = await getVar();
    await themeButton().click();
    await app.window.waitForTimeout(400);
    const after = await getVar();
    expect(after).not.toBe(before);
  });
});

test.describe('布局骨架', () => {
  test('标题栏元素存在且图标用相对路径', async () => {
    await expect(app.window.locator('#titlebar')).toBeVisible();
    await expect(app.window.locator('#titlebar-icon')).toBeVisible();
    const src = await app.window.locator('#titlebar-icon').getAttribute('src');
    expect(src).toBe('./icon.png');
  });

  test('菜单栏六个顶级项', async () => {
    await expect(app.window.locator('#menubar')).toBeVisible();
    const labels = (await app.window.locator('#menubar .menubar-item').allTextContents()).map((t) =>
      t.trim()
    );
    expect(labels).toEqual(['文件', '编辑', '格式', '段落', '视图', '帮助']);
  });

  test('自绘菜单栏点击调用 popupMenu（smoke）', async () => {
    // 点击「文件」触发 menu:popup IPC，主进程弹原生子菜单；无异常即通过
    await app.window.locator('#menubar .menubar-item', { hasText: '文件' }).click();
    await app.window.waitForTimeout(300);
    // 收起原生菜单，避免遮挡后续交互
    await app.window.keyboard.press('Escape');
  });

  test('状态栏字数随输入更新', async () => {
    await loadContent(app, '你好世界 hello');
    await app.window.waitForTimeout(500);
    // 4 个中文字 + 1 个英文单词 = 5 词
    await expect(app.window.locator('#word-count')).toContainText('字数 5');
  });

  test('光标行列随位置更新', async () => {
    await loadContent(app, '第一行\n第二行');
    await app.window.locator('.ProseMirror').click();
    await app.window.keyboard.press('End');
    await app.window.waitForTimeout(400);
    const pos = (await app.window.locator('#cursor-pos').textContent()) ?? '';
    expect(pos).toMatch(/行 [12]/);
  });
});

test.describe('大纲面板', () => {
  /** 归一化大纲展开态（localStorage 会持久化，可能残留上一次测试的折叠态） */
  async function ensureOutlineOpen(): Promise<void> {
    const collapsed = await app.window
      .locator('#app')
      .evaluate((el) => el.classList.contains('outline-collapsed'));
    if (collapsed) {
      await sendCommand(app, 'view:outline');
      await app.window.waitForTimeout(300);
    }
  }

  /** 12 个标题的长文档（标题间夹正文，保证两种模式都需要滚动） */
  function longSectionsDoc(): string {
    return Array.from({ length: 12 }, (_, i) =>
      `# 第 ${i + 1} 章\n\n章节${i + 1}正文`.repeat(3)
    ).join('\n\n');
  }

  test('标题收集与点击跳转', async () => {
    await ensureOutlineOpen();
    const sections = longSectionsDoc();
    await loadContent(app, sections);
    const items = app.window.locator('#outline-tree .outline-item');
    await expect(items).toHaveCount(12, { timeout: 5000 });

    // 记录点击前的滚动位置
    const scrollTopBefore = await app.window
      .locator('#editor-container')
      .evaluate((el) => el.scrollTop);
    // 点击第 10 个标题
    await items.nth(9).evaluate((el) => (el as HTMLButtonElement).click());
    // 平滑滚动动画完成后验证位置（动画时长 ~300-500ms，1.5s 足够）
    await app.window.waitForTimeout(1500);
    const scrollTopAfter = await app.window
      .locator('#editor-container')
      .evaluate((el) => el.scrollTop);
    expect(scrollTopAfter).toBeGreaterThan(scrollTopBefore + 100);
    // 对应大纲项高亮 active
    await expect(items.nth(9)).toHaveClass(/active/);
  });

  test('源码模式下点击大纲跳转到对应源码行', async () => {
    await ensureOutlineOpen();
    const content = '# 一级标题\n\n## 二级标题\n\n正文段落\n\n### 三级标题\n';
    await loadContent(app, content);
    await sendCommand(app, 'view:source');
    await expect(app.window.locator('#source-textarea')).toBeVisible({ timeout: 5000 });

    const items = app.window.locator('#outline-tree .outline-item');
    await expect(items).toHaveCount(3, { timeout: 5000 });

    // 点击第二个标题（## 二级标题）
    await items.nth(1).evaluate((el) => (el as HTMLButtonElement).click());
    await app.window.waitForTimeout(300);

    // 光标应落在源码第 3 行标题文本起点（第 2 行后 + "## "）
    const caret = await app.window.evaluate(() => {
      const el = document.querySelector('#source-textarea') as HTMLElement;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return -1;
      const range = sel.getRangeAt(0);
      const pre = document.createRange();
      pre.selectNodeContents(el);
      pre.setEnd(range.startContainer, range.startOffset);
      return pre.toString().length;
    });
    expect(caret).toBe('# 一级标题\n\n'.length + '## '.length);

    // 仍停留在源码模式，且对应大纲项高亮
    await expect(app.window.locator('#editor')).toBeHidden();
    await expect(items.nth(1)).toHaveClass(/active/);

    // 光标移到首行标题 → active 联动到第一项（keyup 事件由真实键盘触发）
    await app.window.evaluate(() => {
      const el = document.querySelector('#source-textarea') as HTMLElement;
      const first = el.firstChild as Text;
      const sel = window.getSelection()!;
      const range = document.createRange();
      range.setStart(first, 1);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    });
    await app.window.waitForTimeout(200);
    await expect(items.nth(0)).toHaveClass(/active/);
    await expect(items.nth(1)).not.toHaveClass(/active/);

    // 退出源码模式，恢复渲染视图
    await sendCommand(app, 'view:source');
    await expect(app.window.locator('#source-textarea')).toBeHidden({ timeout: 5000 });
  });

  test('源码模式跳转：标题对齐视口顶部（与渲染模式一致）', async () => {
    await ensureOutlineOpen();
    const sections = longSectionsDoc();
    await loadContent(app, sections);
    await sendCommand(app, 'view:source');
    await expect(app.window.locator('#source-textarea')).toBeVisible({ timeout: 5000 });

    const items = app.window.locator('#outline-tree .outline-item');
    await expect(items).toHaveCount(12, { timeout: 5000 });

    // 跳转到第 10 个标题（长文档，必然滚动）
    await items.nth(9).evaluate((el) => (el as HTMLButtonElement).click());
    await app.window.waitForTimeout(1500);

    // 光标所在行顶应贴近源码区顶（±40px 容差；对齐顶部而非居中）
    const offsetTop = await app.window.evaluate(() => {
      const el = document.querySelector('#source-textarea') as HTMLElement;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return Number.MAX_SAFE_INTEGER;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      return rect.top - el.getBoundingClientRect().top;
    });
    expect(Math.abs(offsetTop)).toBeLessThan(40);

    // 退出源码模式
    await sendCommand(app, 'view:source');
    await expect(app.window.locator('#source-textarea')).toBeHidden({ timeout: 5000 });
  });

  test('渲染模式滚动后大纲高亮跟随视口', async () => {
    await ensureOutlineOpen();
    await loadContent(app, longSectionsDoc());
    const items = app.window.locator('#outline-tree .outline-item');
    await expect(items).toHaveCount(12, { timeout: 5000 });

    // 滚到底部：最后一个标题滚过视口顶部 → 高亮最后一项
    await app.window.locator('#editor-container').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await app.window.waitForTimeout(300);
    await expect(items.nth(11)).toHaveClass(/active/);

    // 滚回顶部：视口顶在第一个标题上方 → 高亮第一项
    await app.window.locator('#editor-container').evaluate((el) => {
      el.scrollTop = 0;
    });
    await app.window.waitForTimeout(300);
    await expect(items.nth(0)).toHaveClass(/active/);
  });

  test('源码模式滚动后大纲高亮跟随视口', async () => {
    await ensureOutlineOpen();
    await loadContent(app, longSectionsDoc());
    await sendCommand(app, 'view:source');
    await expect(app.window.locator('#source-textarea')).toBeVisible({ timeout: 5000 });
    const items = app.window.locator('#outline-tree .outline-item');
    await expect(items).toHaveCount(12, { timeout: 5000 });

    // 滚到底部：最后一个标题滚过视口顶部 → 高亮最后一项
    await app.window.locator('#source-textarea').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await app.window.waitForTimeout(300);
    await expect(items.nth(11)).toHaveClass(/active/);

    await sendCommand(app, 'view:source');
    await expect(app.window.locator('#source-textarea')).toBeHidden({ timeout: 5000 });
  });

  test('空文档显示提示', async () => {
    await ensureOutlineOpen();
    await loadContent(app, '');
    await expect(app.window.locator('#outline-tree .outline-empty')).toContainText('暂无标题');
  });

  test('大纲面板可收起（view:outline 命令）', async () => {
    await ensureOutlineOpen();
    const panel = app.window.locator('#outline-panel');
    await expect(panel).toBeVisible();

    // 收起：app 容器获得 outline-collapsed（负外边距推出面板）
    await sendCommand(app, 'view:outline');
    await expect(app.window.locator('#app')).toHaveClass(/outline-collapsed/, {
      timeout: 3000
    });

    // 恢复
    await sendCommand(app, 'view:outline');
    await expect(app.window.locator('#app')).not.toHaveClass(/outline-collapsed/, {
      timeout: 3000
    });
  });
});
