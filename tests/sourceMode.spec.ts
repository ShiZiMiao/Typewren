import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchApp,
  closeApp,
  loadContent,
  sendCommand,
  installDialogStubs,
  setDialog,
  type AppHandle
} from './helpers';

let app: AppHandle;

const WORK_DIR = join(tmpdir(), 'typewren-src-test');
const SAVE_PATH = join(WORK_DIR, 'src-doc.md');

test.beforeAll(async () => {
  if (existsSync(WORK_DIR)) rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });
  app = await launchApp();
  await installDialogStubs(app, { saveAs: null, open: null, discard: 1 });
});

test.afterAll(async () => {
  await closeApp(app);
});

/** 把源码模式切到指定状态（幂等：先查当前激活态再切换） */
async function setSourceMode(activate: boolean): Promise<void> {
  const active = await app.window
    .locator('#app')
    .evaluate((el) => el.classList.contains('source-mode'));
  if (active !== activate) {
    await sendCommand(app, 'view:source');
    await app.window.waitForTimeout(200);
  }
  if (activate) {
    await expect(app.window.locator('#source-textarea')).toBeVisible({ timeout: 5000 });
  }
}

test.describe('源码模式', () => {
  /** 读取 CSS.highlights 注册表里全部高亮的 {名称: 数量} */
  const hlState = () =>
    app.window.evaluate(() => {
      const reg = (globalThis as { CSS?: { highlights?: Map<string, { size: number }> } }).CSS
        ?.highlights as Map<string, { size: number }> | undefined;
      if (!reg) return null;
      const out: Record<string, number> = {};
      for (const [name, highlight] of reg) out[name] = highlight?.size ?? 0;
      return out;
    });

  test('切换进入 / 退出', async () => {
    await loadContent(app, '# 标题\n\n正文段落');
    await setSourceMode(true);
    await expect(app.window.locator('#editor')).toBeHidden();

    await setSourceMode(false);
    await expect(app.window.locator('#source-textarea')).toBeHidden({ timeout: 5000 });
  });

  test('源码内容与渲染序列化一致', async () => {
    await loadContent(app, '# 一级标题\n\n**加粗** 与 `代码`');
    await setSourceMode(true);
    const src = await app.window.locator('#source-textarea').textContent();
    expect(src).toContain('# 一级标题');
    expect(src).toContain('**加粗**');
    expect(src).toContain('`代码`');
    await setSourceMode(false);
  });

  test('源码编辑 → 置脏 → 切回渲染同步', async () => {
    await loadContent(app, '# 原标题');
    await setSourceMode(true);

    // 在源码中改标题
    await app.window.locator('#source-textarea').fill('# 源码改过的标题\n');
    await app.window.waitForTimeout(300);
    await expect(app.window.locator('#titlebar-title')).toContainText('●');

    await setSourceMode(false);
    await expect(app.window.locator('.ProseMirror h1')).toHaveText('源码改过的标题', {
      timeout: 5000
    });
  });

  test('源码模式下保存内容正确', async () => {
    await loadContent(app, '', '');
    await setSourceMode(true);
    await app.window.locator('#source-textarea').fill('# 源码保存\n\n段落');
    await app.window.waitForTimeout(300);

    setDialog(app, { saveAs: SAVE_PATH });
    await sendCommand(app, 'save');
    await expect
      .poll(() => (existsSync(SAVE_PATH) ? readFileSync(SAVE_PATH, 'utf-8') : null))
      .toContain('# 源码保存');

    await setSourceMode(false);
  });

  test('源码模式下打开新文档同步刷新（onContentReplaced）', async () => {
    await setSourceMode(true);
    await loadContent(app, '# 新文档标题\n\n新内容', '');
    // 打开新文档后源码视图应与新文档一致
    const src = await app.window.locator('#source-textarea').textContent();
    expect(src).toContain('# 新文档标题');
    await setSourceMode(false);
  });

  test('Tab 键不跳出编辑区（冒烟）', async () => {
    await loadContent(app, '行首文本');
    await setSourceMode(true);
    const ta = app.window.locator('#source-textarea');
    await ta.click();
    // Tab 不应把焦点移出源码编辑器
    await app.window.keyboard.press('Tab');
    await app.window.waitForTimeout(200);
    const focused = await app.window.evaluate(() => {
      return document.activeElement === document.querySelector('#source-textarea');
    });
    expect(focused).toBe(true);
    await setSourceMode(false);
  });

  test('复杂文档（引用块+列表+_/~）源码模式不新添转义', async () => {
    // 回归：milkdown 序列化-解析往返存在结构差异，若回读校验用结构全等
    // 会误判并把全篇退回严格转义（出现 \_ 与 \~）。
    const content = [
      '# 方案',
      '',
      '> **定位**: 未落地方案汇总 + 新增损失函数探索',
      '> **版本**: v1.0',
      '> **前置文档**:',
      '>',
      '> * 《DA、命中率及高置信占比提升方案.md》（v4，7 个方案：H1~H4, C1~C3）',
      '> * 《DA、命中率及高置信占比提升方案_2.md》（v5，6 个方案：D1~D2, H5~H6, C4~C5）',
      '> * 本文件编号顺延：D3~D5, H7~H8',
      '',
      '***',
      ''
    ].join('\n');

    await loadContent(app, content);
    await setSourceMode(true);
    const src = (await app.window.locator('#source-textarea').textContent()) ?? '';

    expect(src).toContain('方案_2.md');
    expect(src).toContain('H1~H4');
    expect(src).toContain('D1~D2');
    expect(src).toContain('H7~H8');
    expect(src).not.toContain('\\_');
    expect(src).not.toContain('\\~');

    await setSourceMode(false);
  });

  test('未编辑文档：磁盘转义原样显示且不置脏', async () => {
    // 文件里的 \~ 必须在源码视图逐字保留（序列化会把它丢成 ~，
    // 因此未编辑时直接显示磁盘原文，而不是序列化结果）。
    const content = 'a\\~\\~b 与 ~~删除~~ 和 foo_bar\n';
    await loadContent(app, content);

    await setSourceMode(true);
    const src = (await app.window.locator('#source-textarea').textContent()) ?? '';
    expect(src).toBe(content);
    await expect(app.window.locator('#titlebar-title')).not.toContainText('●');

    await setSourceMode(false);
    await expect(app.window.locator('#titlebar-title')).not.toContainText('●');
  });

  test('未编辑文档：源码模式保存后磁盘内容与原文一致', async () => {
    const content = 'a\\~\\~b 与 ~~删除~~ 和 foo_bar\n';
    await loadContent(app, content);
    await setSourceMode(true);

    setDialog(app, { saveAs: SAVE_PATH });
    await sendCommand(app, 'save');
    await expect
      .poll(() => (existsSync(SAVE_PATH) ? readFileSync(SAVE_PATH, 'utf-8') : null))
      .toBe(content);

    await setSourceMode(false);
  });

  test('源码模式 Markdown 语法高亮（注册/编辑/清理）', async () => {
    await loadContent(app, '# 标题\n\n**粗体** 与 `代码`\n\n- 列表项\n\n> 引用');
    await setSourceMode(true);

    const hl = await hlState();
    expect(hl).not.toBeNull();
    expect(hl!['typewren-source-section']).toBeGreaterThan(0);
    expect(hl!['typewren-source-strong']).toBeGreaterThan(0);
    expect(hl!['typewren-source-bullet']).toBeGreaterThan(0);
    expect(hl!['typewren-source-quote']).toBeGreaterThan(0);

    // 编辑输入后高亮跟随重建且文本未被破坏
    await app.window.locator('#source-textarea').fill('# 新标题\n\n**新粗体**');
    await app.window.waitForTimeout(400);
    const after = await hlState();
    expect(after!['typewren-source-section']).toBeGreaterThan(0);
    expect(after!['typewren-source-strong']).toBeGreaterThan(0);
    const text = (await app.window.locator('#source-textarea').textContent()) ?? '';
    expect(text).toContain('**新粗体**');

    // 退出源码模式清理源码高亮（搜索栏的 search-* 高亮不受影响）
    await setSourceMode(false);
    const cleared = await hlState();
    expect(cleared).not.toBeNull();
    const sourceKeys = Object.keys(cleared!).filter((k) => k.startsWith('typewren-source-'));
    expect(sourceKeys.length).toBe(0);
  });

  test('表格高亮：table 注册且表内 a_b 不被误判为强调', async () => {
    const content = '| 列A | 列B |\n| --- | --- |\n| 单元格a_b | `c~d` |\n';
    await loadContent(app, content);
    await setSourceMode(true);

    const hl = await hlState();
    expect(hl).not.toBeNull();
    expect(hl!['typewren-source-table']).toBeGreaterThan(0);
    // 单元格内行内代码正确识别
    expect(hl!['typewren-source-code']).toBeGreaterThan(0);
    // 回归：旧 hljs 会把 a_b 误判成 emphasis；新内核必须无此高亮
    expect(hl!['typewren-source-emphasis']).toBeUndefined();
    expect(hl!['typewren-source-strikethrough']).toBeUndefined();

    const text = (await app.window.locator('#source-textarea').textContent()) ?? '';
    expect(text).toBe(content);
    await setSourceMode(false);
  });

  test('删除线高亮：strikethrough 注册且文本完整', async () => {
    const content = '~~删除的内容~~ 与 ~~再删~~\n';
    await loadContent(app, content);
    await setSourceMode(true);

    const hl = await hlState();
    expect(hl).not.toBeNull();
    expect(hl!['typewren-source-strikethrough']).toBeGreaterThan(0);

    const text = (await app.window.locator('#source-textarea').textContent()) ?? '';
    expect(text).toBe(content);
    await setSourceMode(false);
  });

  test('嵌套强调高亮：不破坏文本且内外都着色', async () => {
    const content = '**粗体 *斜* 体**\n';
    await loadContent(app, content);
    await setSourceMode(true);

    const hl = await hlState();
    expect(hl).not.toBeNull();
    expect(hl!['typewren-source-strong']).toBeGreaterThan(0);
    expect(hl!['typewren-source-emphasis']).toBeGreaterThan(0);

    const text = (await app.window.locator('#source-textarea').textContent()) ?? '';
    expect(text).toBe(content);
    await setSourceMode(false);
  });
});
