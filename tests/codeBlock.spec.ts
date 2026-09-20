import { test, expect } from '@playwright/test';
import { closeApp, launchApp, loadContent, type AppHandle } from './helpers';

/* ============================================================
 * 代码块体验（Typora 参考）：
 * 1. 代码块内输入 ( [ " 自动成对（IDE 式，不受两侧安全限制）；
 *    正文维持"两侧安全"规则；行内代码内不补全；
 * 2. 空语言代码块：内容稳定后自动识别语言并直接显示（不再恒挂「自动」）；
 * 3. 语言角标可点击修改/清空语言（promptDialog）。
 * ============================================================ */

let app: AppHandle;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await closeApp(app);
});

test.describe('代码块内自动补全', () => {
  test('输入 ( 自动成对且光标居中，再输 " 同样成对', async () => {
    await loadContent(app, '```python\nx = \n```');
    const code = app.window.locator('.ProseMirror pre code');

    await code.click();
    await app.window.keyboard.press('End');
    await app.window.keyboard.type('(');
    await app.window.waitForTimeout(200);
    expect((await code.evaluate((el) => el.textContent)) ?? '').toBe('x = ()');

    // 光标在 () 中间：继续输入落在括号内
    await app.window.keyboard.type('abc');
    await app.window.waitForTimeout(200);
    expect((await code.evaluate((el) => el.textContent)) ?? '').toBe('x = (abc)');

    // 光标移到行尾（DOM 选区定位，无头下 End/箭头键在 code 块内不可靠），
    // 再输 " → 自动成对 ""
    await code.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await app.window.waitForTimeout(150);
    await app.window.keyboard.type('"');
    await app.window.waitForTimeout(200);
    expect((await code.evaluate((el) => el.textContent)) ?? '').toBe('x = (abc)""');

    // 光标在 "" 中间：输入单词后应为 "vvv"
    await app.window.keyboard.type('vvv');
    await app.window.waitForTimeout(200);
    expect((await code.evaluate((el) => el.textContent)) ?? '').toBe('x = (abc)"vvv"');
  });

  test('再输一次闭符不产生重影（跳过自动补的关符号）', async () => {
    await loadContent(app, '```js\nf\n```');
    const code = app.window.locator('.ProseMirror pre code');
    await code.click();
    await app.window.keyboard.press('End');
    // 在 f 后输入 "(" → f()
    await app.window.keyboard.type('(');
    await app.window.waitForTimeout(200);
    expect((await code.evaluate((el) => el.textContent)) ?? '').toBe('f()');
    // 再输入 ")" → 跳过自动补的关符，不产生重影
    await app.window.keyboard.type(')');
    await app.window.waitForTimeout(200);
    expect((await code.evaluate((el) => el.textContent)) ?? '').toBe('f()');
  });

  test('代码块内 * 不自动补全（Markdown 标记维持原样）', async () => {
    await loadContent(app, '```python\nx = 1\n```');
    const code = app.window.locator('.ProseMirror pre code');
    await code.click();
    await app.window.keyboard.press('End');
    await app.window.keyboard.type(' * 2');
    await app.window.waitForTimeout(200);
    expect((await code.evaluate((el) => el.textContent)) ?? '').toBe('x = 1 * 2');
  });

  test('正文维持两侧安全：段中间 ( 不自动成对', async () => {
    await loadContent(app, '正文段');
    await app.window.locator('.ProseMirror p', { hasText: '正文段' }).click();
    await app.window.keyboard.press('End');
    await app.window.keyboard.type('(');
    await app.window.waitForTimeout(200);
    await expect(app.window.locator('.ProseMirror p')).toContainText('正文段(');
  });
});

test.describe('代码块语言自动识别与角标', () => {
  /** 点击角标前先清理可能遗留的就地编辑器（点正文空白处关闭） */
  async function clickBadge(): Promise<ReturnType<typeof app.window.locator>> {
    await app.window.locator('.ProseMirror').click({ position: { x: 40, y: 8 } });
    await app.window.waitForTimeout(100);
    await app.window.locator('.ProseMirror pre .code-lang-badge').click();
    return app.window.locator('#language-editor');
  }

  test('有语言：点击角标就地变输入框 + 浮层列表，点选应用（无模态弹窗）', async () => {
    await loadContent(app, '```python\nprint("666")\n```');
    const badge = app.window.locator('.ProseMirror pre .code-lang-badge');
    await expect(badge).toHaveText('python');

    await clickBadge();
    await expect(app.window.locator('#language-editor')).toBeVisible({ timeout: 5000 });
    await expect(app.window.locator('.language-dropdown')).toBeVisible();
    // 无模态弹窗（Typora 式就地交互）
    await expect(app.window.locator('#language-picker')).toHaveCount(0);
    await expect(
      app.window.locator('.language-dropdown .language-item[data-language="python"]')
    ).toHaveCount(1);

    // 点击列表项 javascript → 立即应用并收起
    await app.window
      .locator('.language-dropdown .language-item[data-language="javascript"]')
      .click();
    await app.window.waitForTimeout(300);

    await expect(app.window.locator('#language-editor')).toBeHidden();
    await expect(badge).toHaveText('javascript');
    await expect(app.window.locator('.ProseMirror pre[data-language="javascript"]')).toHaveCount(1);
  });

  test('输入过滤列表后点击应用', async () => {
    await loadContent(app, '```\nn = 1\n```');
    const badge = app.window.locator('.ProseMirror pre .code-lang-badge');
    await expect(badge).toHaveText('自动');
    await clickBadge();
    await expect(app.window.locator('#language-editor')).toHaveValue('');

    // 输入 "py" 过滤：只剩含 py 的语言
    await app.window.locator('#language-editor').fill('py');
    await app.window.waitForTimeout(150);
    const items = await app.window.locator('.language-dropdown .language-item').allTextContents();
    expect(items.some((t) => t.trim() === 'python')).toBe(true);
    expect(items.every((t) => t.toLowerCase().includes('py'))).toBe(true);

    await app.window.locator('.language-dropdown .language-item[data-language="python"]').click();
    await app.window.waitForTimeout(200);
    await expect(badge).toHaveText('python');
    await expect(app.window.locator('.ProseMirror pre[data-language="python"]')).toHaveCount(1);
  });

  test('空语言：内容稳定后自动识别（python）并直接显示，回车应用识别结果', async () => {
    await loadContent(app, '```\nimport os\nprint("666")\n```');
    const badge = app.window.locator('.ProseMirror pre .code-lang-badge');
    // 防抖 800ms 后自动识别：角标直接显示语言（不写文档）
    await expect(badge).toHaveText('python', { timeout: 5000 });
    await expect(app.window.locator('.ProseMirror pre[data-language]')).toHaveCount(0);

    // 点击角标：就地编辑器预填识别结果，回车应用（无头下先显式聚焦输入框）
    await clickBadge();
    await expect(app.window.locator('#language-editor')).toHaveValue('python');
    await app.window.locator('#language-editor').click();
    await app.window.keyboard.press('Enter');
    await app.window.waitForTimeout(300);
    await expect(app.window.locator('.ProseMirror pre[data-language="python"]')).toHaveCount(1);
  });

  test('自动识别：javascript 风格代码直接显示', async () => {
    await loadContent(app, '```\nconst sum = (a, b) => a + b;\nconsole.log(sum(1, 2));\n```');
    const badge = app.window.locator('.ProseMirror pre .code-lang-badge');
    await expect(badge).toHaveText('javascript', { timeout: 5000 });
    await expect(app.window.locator('.ProseMirror pre[data-language]')).toHaveCount(0);
  });

  test('无特征代码不识别：保持「自动」角标', async () => {
    await loadContent(app, '```\nhello, world!\n```');
    const badge = app.window.locator('.ProseMirror pre .code-lang-badge');
    await expect(badge).toHaveText('自动', { timeout: 5000 });
    await expect(app.window.locator('.ProseMirror pre[data-language]')).toHaveCount(0);
  });

  test('清空语言：输入为空回车 = 清除，随后自动识别重新显示并可再应用', async () => {
    await loadContent(app, '```python\nprint("666")\n```');
    const badge = app.window.locator('.ProseMirror pre .code-lang-badge');
    await expect(badge).toHaveText('python');

    await clickBadge();
    await expect(app.window.locator('#language-editor')).toBeVisible({ timeout: 5000 });
    await app.window.locator('#language-editor').fill('');
    await app.window.locator('#language-editor').click();
    await app.window.keyboard.press('Enter');
    await app.window.waitForTimeout(200);
    await expect(badge).toHaveText('自动');

    // 防抖后自动识别重新显示（未写文档）
    await expect(badge).toHaveText('python', { timeout: 5000 });
    await expect(app.window.locator('.ProseMirror pre[data-language]')).toHaveCount(0);

    // 点击 → 预填 → 回车应用
    await clickBadge();
    await expect(app.window.locator('#language-editor')).toHaveValue('python');
    await app.window.locator('#language-editor').click();
    await app.window.keyboard.press('Enter');
    await app.window.waitForTimeout(300);
    await expect(app.window.locator('.ProseMirror pre[data-language="python"]')).toHaveCount(1);
  });

  test('Esc 取消：编辑器收起、语言不变', async () => {
    await loadContent(app, '```python\nprint("666")\n```');
    const badge = app.window.locator('.ProseMirror pre .code-lang-badge');
    await expect(badge).toHaveText('python');
    await clickBadge();
    await expect(app.window.locator('#language-editor')).toBeVisible({ timeout: 5000 });
    await app.window.locator('#language-editor').click();
    await app.window.keyboard.press('Escape');
    await expect(app.window.locator('#language-editor')).toBeHidden({ timeout: 3000 });
    await expect(badge).toHaveText('python');
    await expect(app.window.locator('.ProseMirror pre[data-language="python"]')).toHaveCount(1);
  });

  test('点击编辑器外部：就地编辑器收起（不改变语言）', async () => {
    const badge = app.window.locator('.ProseMirror pre .code-lang-badge');
    await expect(badge).toHaveText('python');
    await clickBadge();
    await expect(app.window.locator('#language-editor')).toBeVisible({ timeout: 5000 });
    await app.window.locator('.ProseMirror').click({ position: { x: 40, y: 8 } });
    await expect(app.window.locator('#language-editor')).toBeHidden({ timeout: 3000 });
    await expect(badge).toHaveText('python');
    await expect(app.window.locator('.ProseMirror pre[data-language="python"]')).toHaveCount(1);
  });
});
