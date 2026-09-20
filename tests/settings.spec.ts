import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeApp, launchApp, loadContent, sendCommand, type AppHandle } from './helpers';

/* ============================================================
 * 偏好设置（第一优先任务）：对话框读写、即时生效、重启保留、自动保存
 * 用独立 --user-data-dir 隔离 settings.json / localStorage，
 * 避免与其它 spec 共用默认配置互相污染。
 * ============================================================ */

let app: AppHandle;
let dataDir: string;
let docPath: string;

function settingsFile(): string {
  return join(dataDir, 'settings.json');
}

function readSettingsFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsFile(), 'utf-8'));
}

const MS_YH = "'Microsoft YaHei', 'PingFang SC', sans-serif";

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'typewren-settings-'));
  docPath = join(dataDir, 'autosave-doc.md');
  app = await launchApp([`--user-data-dir=${dataDir}`]);
});

test.afterAll(async () => {
  await closeApp(app);
});

async function openSettings(): Promise<void> {
  await sendCommand(app, 'file:preferences');
  await expect(app.window.locator('#settings-dialog')).toBeVisible({ timeout: 5000 });
}

test.describe('偏好设置', () => {
  test('菜单含「偏好设置…」入口（文件菜单，带快捷键）', async () => {
    const found = await app.app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      const file = menu?.items.find((i) => i.label === '文件');
      return file?.submenu?.items.some((i) => i.label === '偏好设置…') ?? false;
    });
    expect(found).toBe(true);
  });

  test('打开对话框并展示默认值', async () => {
    await openSettings();
    await expect(app.window.locator('#settings-font-size')).toHaveValue('16');
    await expect(app.window.locator('#settings-line-height')).toHaveValue('1.75');
    await expect(app.window.locator('#settings-editor-width')).toHaveValue('1200');
    await expect(app.window.locator('#settings-theme')).toHaveValue('system');
    await expect(app.window.locator('#settings-autosave')).not.toBeChecked();
    await expect(app.window.locator('#settings-draft-interval')).toHaveValue('30');
  });

  test('排版修改即时生效（字号/行距/宽度/字体）', async () => {
    await app.window.locator('#settings-font-size').fill('20');
    await app.window.locator('#settings-line-height').fill('2');
    await app.window.locator('#settings-editor-width').fill('1400');
    await app.window.locator('#settings-font-family').selectOption(MS_YH);
    await app.window.waitForTimeout(300);

    const pm = app.window.locator('.ProseMirror');
    const font = await pm.evaluate((el) => getComputedStyle(el as HTMLElement).fontSize);
    expect(font).toBe('20px');
    const vars = await app.window.evaluate(() => {
      const st = getComputedStyle(document.documentElement);
      return {
        lineHeight: st.getPropertyValue('--editor-line-height').trim(),
        width: st.getPropertyValue('--editor-max-width').trim(),
        family: st.getPropertyValue('--editor-font-family').trim()
      };
    });
    expect(vars.lineHeight).toBe('2');
    expect(vars.width).toBe('min(90vw, 1400px)');
    expect(vars.family).toBe(MS_YH);
    const familyComputed = await pm.evaluate(
      (el) => getComputedStyle(el as HTMLElement).fontFamily
    );
    expect(familyComputed).toContain('Microsoft YaHei');
  });

  test('主题下拉切换生效', async () => {
    await app.window.locator('#settings-theme').selectOption('dark');
    // theme 走 nativeTheme 时钟（广播或 300ms 兜底）
    await app.window.waitForTimeout(600);
    const theme = await app.window.evaluate(() => document.documentElement.dataset.theme);
    expect(theme).toBe('dark');
  });

  test('拼写检查开关生效（编辑器 spellcheck 属性）', async () => {
    await app.window.locator('#settings-spellcheck').check();
    await app.window.waitForTimeout(200);
    expect(
      await app.window.evaluate(() =>
        document.querySelector('.ProseMirror')?.getAttribute('spellcheck')
      )
    ).toBe('true');
  });

  test('自动保存：开启后定时写盘（无需 Ctrl+S）', async () => {
    await app.window.locator('#settings-autosave').check();
    await app.window.locator('#settings-autosave-interval').fill('5');
    await app.window.waitForTimeout(300);

    // 模态设置框会拦截编辑器点击：先关闭再编辑
    await app.window.locator('#settings-close').click();
    await expect(app.window.locator('#settings-dialog')).toBeHidden({ timeout: 3000 });

    writeFileSync(docPath, '初始内容', 'utf-8');
    await loadContent(app, '初始内容', docPath);
    await app.window.locator('.ProseMirror').click();
    await app.window.keyboard.press('Control+End');
    await app.window.keyboard.type('追加文本');

    // 5s 间隔自动保存：轮询磁盘内容直到出现追加文本
    await expect
      .poll(
        () => {
          try {
            return readFileSync(docPath, 'utf-8');
          } catch {
            return '';
          }
        },
        { timeout: 12000, intervals: [500] }
      )
      .toContain('追加文本');
  });

  test('settings.json 持久化内容正确', async () => {
    const s = readSettingsFile();
    expect(s.fontSize).toBe(20);
    expect(s.lineHeight).toBe(2);
    expect(s.editorWidth).toBe(1400);
    expect(s.fontFamily).toBe(MS_YH);
    expect(s.theme).toBe('dark');
    expect(s.spellcheck).toBe(true);
    expect(s.autoSave).toBe(true);
    expect(s.autoSaveInterval).toBe(5);
  });

  test('重启后设置保留（排版/主题/对话框回显）', async () => {
    await closeApp(app);
    app = await launchApp([`--user-data-dir=${dataDir}`]);

    // 启动即生效：无需打开对话框，编辑器排版已是设置值
    const font = await app.window
      .locator('.ProseMirror')
      .evaluate((el) => getComputedStyle(el as HTMLElement).fontSize);
    expect(font).toBe('20px');
    expect(await app.window.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');

    await openSettings();
    await expect(app.window.locator('#settings-font-size')).toHaveValue('20');
    await expect(app.window.locator('#settings-line-height')).toHaveValue('2');
    await expect(app.window.locator('#settings-font-family')).toHaveValue(MS_YH);
    await expect(app.window.locator('#settings-theme')).toHaveValue('dark');
    await expect(app.window.locator('#settings-autosave')).toBeChecked();
  });

  test('Esc 关闭对话框', async () => {
    await app.window.keyboard.press('Escape');
    await expect(app.window.locator('#settings-dialog')).toBeHidden({ timeout: 3000 });
  });
});
