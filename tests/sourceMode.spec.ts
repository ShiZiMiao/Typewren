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
  readSource,
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

    await setDialog(app, { saveAs: SAVE_PATH });
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

    await setDialog(app, { saveAs: SAVE_PATH });
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

  test('渲染→源码：光标定位到同一行源码', async () => {
    const content =
      '# 标题一\n\n第一段内容用于定位。\n\n第二段内容用于定位。\n\n第三段内容用于定位。\n';
    await loadContent(app, content);

    // 光标点进渲染视图的第三段
    await app.window.locator('.ProseMirror p').nth(2).click();
    await app.window.waitForTimeout(150);

    await setSourceMode(true);

    // 源码光标所在行应为第三段文本（而非回到文档开头）
    const caretLine = await app.window.evaluate(() => {
      const el = document.getElementById('source-textarea');
      const sel = window.getSelection();
      if (!el || !sel || sel.rangeCount === 0) return '';
      const range = sel.getRangeAt(0);
      const pre = range.cloneRange();
      pre.selectNodeContents(el);
      pre.setEnd(range.startContainer, range.startOffset);
      // 光标所在行 = 光标起点到下一个换行（光标恰在行首时前缀以 \n 结尾，
      // 不能用前缀的最后一个分片）
      return (el.textContent ?? '').slice(pre.toString().length).split('\n')[0] ?? '';
    });
    expect(caretLine).toContain('第三段内容用于定位');

    // 该行在源码区视口内可见（顶部对齐定位生效）
    await expect
      .poll(() =>
        app.window.evaluate(() => {
          const el = document.getElementById('source-textarea');
          const sel = window.getSelection();
          if (!el || !sel || sel.rangeCount === 0) return false;
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          const er = el.getBoundingClientRect();
          return rect.top >= er.top - 1 && rect.bottom <= er.bottom + 1;
        })
      )
      .toBe(true);

    await setSourceMode(false);
  });

  test('渲染→源码：长文档切换瞬移到对应行顶部（无滚动动画）', async () => {
    // 构建 30 段长文档，光标放在第 10 段（附近内容足够多，可完整对齐顶部；
    // 若选太靠近文档末尾，滚动会被 max-scroll 钳制——那不是对齐的问题）
    const paragraphs = Array.from({ length: 30 }, (_, i) => `第${i + 1}段内容用于长文档定位测试。`);
    const content = `${paragraphs.join('\n\n')}\n`;
    await loadContent(app, content);

    await app.window.locator('.ProseMirror p').nth(9).click();
    await app.window.waitForTimeout(150);

    await setSourceMode(true);

    // 光标行应顶到源码区顶部（与渲染模式跳转一致，且 rAF 一帧内到位）
    const topGap = await app.window.evaluate(() => {
      const el = document.getElementById('source-textarea');
      const sel = window.getSelection();
      if (!el || !sel || sel.rangeCount === 0) return -1;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      return rect.top - el.getBoundingClientRect().top;
    });
    expect(topGap).toBeGreaterThanOrEqual(-2);
    expect(topGap).toBeLessThan(60);

    // 瞬时定位：进入后短暂等待即应稳定（smooth 动画此时仍在滚动中）
    await app.window.waitForTimeout(150);
    const stable = await app.window.evaluate(() => {
      const el = document.getElementById('source-textarea');
      const sel = window.getSelection();
      if (!el || !sel || sel.rangeCount === 0) return -1;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      return rect.top - el.getBoundingClientRect().top;
    });
    expect(stable).toBe(topGap);

    await setSourceMode(false);
  });

  test('源码→渲染：光标回到渲染视图同一块', async () => {
    const content =
      '# 标题一\n\n第一段内容用于定位。\n\n第二段内容用于定位。\n\n第三段内容用于定位。\n';
    await loadContent(app, content);
    await setSourceMode(true);

    // 源码光标移到第三段行（Ctrl+Home 后向下 6 行：含两个空行分隔）
    await app.window.keyboard.press('Control+Home');
    for (let i = 0; i < 6; i++) await app.window.keyboard.press('ArrowDown');
    await app.window.waitForTimeout(150);

    await setSourceMode(false);

    // PM 选区（DOM 选区随之同步）应落在第三段块内
    await expect
      .poll(() =>
        app.window.evaluate(() => {
          const sel = window.getSelection();
          if (!sel || sel.rangeCount === 0) return null;
          const p = sel.getRangeAt(0).startContainer.parentElement;
          const block = p?.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, pre');
          return block?.textContent ?? null;
        })
      )
      .toBe('第三段内容用于定位。');
  });
});

// ========== 回归 ==========

test.describe('回归：源码模式真实回车（contenteditable 拆块）', () => {
  test('真实 Enter 换行在 getText/保存里保留', async () => {
    await loadContent(app, '第一行内容', '');
    await setSourceMode(true);

    // 全程操作**真实**的 #source-textarea——历史上这里换过 plaintext-only
    // 克隆体做探针实验（断言的不是被测元素，等于没测），回归必须打真元素
    const ta = app.window.locator('#source-textarea');
    await ta.click();
    // 光标挪到行尾（DOM 选区；无头环境下 End/方向键不保证生效）
    await app.window.evaluate(() => {
      const el = document.querySelector('#source-textarea') as HTMLElement;
      const sel = window.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    });

    // 真实回车 + 真实打字（Enter 未被拦截时：Blink 默认 insertParagraph 把
    // contenteditable 拆成 <div>/<br> 结构，块边界换行从 textContent 消失——
    // 脏检测/保存/退出全基于 textContent，换行会整个丢失）
    await app.window.keyboard.press('Enter');
    await app.window.keyboard.type('第二行内容');
    await app.window.waitForTimeout(300);

    // getText（readSource 与 getText 同为 textContent）里 '\n' 必须以
    // 文本节点字符形态被保留，而不是被拆块吞掉
    expect(await readSource(app)).toBe('第一行内容\n第二行内容');

    // 无块级元素：insertParagraph 的 <div>/<br> 产物不得出现
    //（语法高亮走 CSS.highlights 区间着色不动 DOM，innerHTML 里只应有文本节点）
    const html = await app.window.locator('#source-textarea').innerHTML();
    expect(html).not.toContain('<div');
    expect(html).not.toContain('<br');

    // 保存回归：写盘内容的换行与源码视图一致
    await setDialog(app, { saveAs: SAVE_PATH });
    await sendCommand(app, 'save');
    await expect
      .poll(() => (existsSync(SAVE_PATH) ? readFileSync(SAVE_PATH, 'utf-8') : null))
      .toContain('第一行内容\n第二行内容');

    await setSourceMode(false);
  });
});

test.describe('回归：内容区缩放下渲染→源码定位（屏幕/局部单位混用）', () => {
  test('zoom 120% 切源码：光标行顶部对齐不偏移', async () => {
    // 内容区缩放到 120%（步进 10 个百分点 ×2）
    await sendCommand(app, 'view:zoom-in');
    await sendCommand(app, 'view:zoom-in');

    const paragraphs = Array.from({ length: 30 }, (_, i) => `第${i + 1}段内容用于长文档定位测试。`);
    await loadContent(app, `${paragraphs.join('\n\n')}\n`);
    await app.window.locator('.ProseMirror p').nth(9).click();
    await app.window.waitForTimeout(150);

    await setSourceMode(true);

    // 光标行应顶到源码区顶部：滚动目标 = scrollTop + rect 差值 ÷ zoom
    // （rect 差值是屏幕像素、scrollTop 是局部单位；旧行直接相加，
    // zoom≠100% 时过冲 (zoom-1)×偏移——长文档下光标被顶出视口顶部）
    const topGap = await app.window.evaluate(() => {
      const el = document.getElementById('source-textarea');
      const sel = window.getSelection();
      if (!el || !sel || sel.rangeCount === 0) return -1;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      return rect.top - el.getBoundingClientRect().top;
    });
    expect(topGap).toBeGreaterThanOrEqual(-2);
    expect(topGap).toBeLessThan(60);

    await setSourceMode(false);
    // 恢复缩放，避免影响后续用例
    await sendCommand(app, 'view:zoom-reset');
  });
});
