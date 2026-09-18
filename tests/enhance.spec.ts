import { test, expect } from '@playwright/test';
import { closeApp, launchApp, loadContent, sendCommand, type AppHandle } from './helpers';

let app: AppHandle;

/** 直接把 localStorage 置为确定值后 reload（避免 toggle 语义歧义） */
async function presetSetting(key: string, value: string): Promise<void> {
  await app.window.evaluate(([k, v]) => localStorage.setItem(k, v), [key, value]);
  await app.window.reload();
  await app.window.waitForSelector('.ProseMirror', { timeout: 15000 });
  await app.window.waitForTimeout(400);
}

test.beforeAll(async () => {
  app = await launchApp();
  await app.window.evaluate(() => {
    localStorage.removeItem('typewren.auto-pairs');
    localStorage.removeItem('typewren.spellcheck');
  });
  await app.window.reload();
  await app.window.waitForSelector('.ProseMirror', { timeout: 15000 });
  await app.window.waitForTimeout(400);
});

test.afterAll(async () => {
  await closeApp(app);
});

test.describe('编辑增强', () => {
  test('拼写检查开关：编辑器属性与主进程状态联动', async () => {
    await presetSetting('typewren.spellcheck', '0');
    await loadContent(app, '拼写检查测试');
    expect(
      await app.window.evaluate(() =>
        document.querySelector('.ProseMirror')?.getAttribute('spellcheck')
      )
    ).toBe('false');

    await sendCommand(app, 'edit:spellcheck');
    await app.window.waitForTimeout(200);
    expect(
      await app.window.evaluate(() =>
        document.querySelector('.ProseMirror')?.getAttribute('spellcheck')
      )
    ).toBe('true');

    await sendCommand(app, 'edit:spellcheck');
    await app.window.waitForTimeout(200);
    expect(
      await app.window.evaluate(() =>
        document.querySelector('.ProseMirror')?.getAttribute('spellcheck')
      )
    ).toBe('false');
  });

  test('成对符号补全：括号自动成对与跳过', async () => {
    await presetSetting('typewren.auto-pairs', '1');
    await loadContent(app, '');
    await app.window.locator('.ProseMirror').click();
    await app.window.keyboard.type('(');
    await expect(app.window.locator('.ProseMirror')).toContainText('()');
    // 光标应在中间：继续输入字母落在括号内
    await app.window.keyboard.type('abc');
    await expect(app.window.locator('.ProseMirror')).toContainText('(abc)');

    // 跳过：光标在 ")" 前输入 ")" → 跳过不产生额外括号
    await app.window.keyboard.press('End');
    await app.window.keyboard.press('ArrowLeft');
    await app.window.keyboard.type(')');
    await app.window.waitForTimeout(150);
    await expect(app.window.locator('.ProseMirror')).toContainText('(abc)');
    const count =
      ((await app.window.locator('.ProseMirror').textContent()) ?? '').split(')').length - 1;
    expect(count).toBe(1);
  });

  test('成对符号补全：星号在非安全位置不强制补全（输入规则不受扰动）', async () => {
    await presetSetting('typewren.auto-pairs', '1');
    await loadContent(app, '');
    await app.window.locator('.ProseMirror').click();
    // 行首输入单个 *（两侧安全 → 补全 ** 光标居中）
    await app.window.keyboard.type('*');
    await app.window.waitForTimeout(120);
    const text = (await app.window.locator('.ProseMirror').textContent()) ?? '';
    expect(text).toBe('**');
    // 中间补字（光标居中，正文落在两个星号之间）
    await app.window.keyboard.type('加粗');
    await app.window.waitForTimeout(120);
    // 补字后光标在"粗"后、闭合星号前：再输入 * 时前字符非安全位（粗 紧邻），
    // 补全必须不插手 → 文本应保持两个星号，不变成三个
    await app.window.keyboard.type('*');
    await app.window.waitForTimeout(120);
    const finalText = (await app.window.locator('.ProseMirror').textContent()) ?? '';
    expect(finalText.replace(/\*/g, '')).toBe('加粗');
    const starCount = (finalText.match(/\*/g) ?? []).length;
    expect(starCount).toBeLessThanOrEqual(2);
  });

  test('成对符号补全：连续星号形成 **加粗**（不出现 *** 与残留星）', async () => {
    await presetSetting('typewren.auto-pairs', '1');
    await loadContent(app, '');
    await app.window.locator('.ProseMirror').click();
    // ** ：第二颗 * 应跳过（光标越过自动补的关符号），文档保持 **
    await app.window.keyboard.type('*');
    await app.window.keyboard.type('*');
    await app.window.waitForTimeout(120);
    expect((await app.window.locator('.ProseMirror').textContent()) ?? '').toBe('**');
    // 正文 + 两次 * 收尾 → 强调规则转成粗体，无残留星号
    await app.window.keyboard.type('加粗');
    await app.window.keyboard.type('*');
    await app.window.keyboard.type('*');
    await app.window.waitForTimeout(200);
    const finalText = (await app.window.locator('.ProseMirror').textContent()) ?? '';
    expect(finalText.replace(/\*/g, '')).toBe('加粗');
    expect((finalText.match(/\*/g) ?? []).length).toBe(0);
  });
});
