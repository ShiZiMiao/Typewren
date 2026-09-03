import { test, expect } from '@playwright/test';
import { launchApp, closeApp, loadContent, sendCommand } from './helpers';

let app: AppHandle;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await closeApp(app);
});

// ========== 表格显示（纯 CSS 方案：根节点不设横向滚动，包裹层承载滚动条） ==========

test.describe('表格显示', () => {
  test('编辑器存在', async () => {
    const editor = app.window.locator('.ProseMirror');
    await expect(editor).toBeVisible();
  });

  test('表格样式变量存在', async () => {
    const hasTableStyles = await app.window.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        hasBorder: style.getPropertyValue('--border-strong') !== '',
        hasTableHeadBg: style.getPropertyValue('--table-head-bg') !== ''
      };
    });

    expect(hasTableStyles.hasBorder).toBeTruthy();
    expect(hasTableStyles.hasTableHeadBg).toBeTruthy();
  });

  test('PM 根节点不承载横向滚动（overflow-x: visible）', async () => {
    // AGENTS.md 决策 #10：勿在 PM 设 overflow-x:auto，否则截断表格溢出。
    const overflowX = await app.window
      .locator('.ProseMirror')
      .evaluate((el) => getComputedStyle(el).overflowX);
    expect(overflowX).toBe('visible');
  });

  test('.table-scroll-wrapper 承载横向滚动', async () => {
    await loadContent(app, '| 一 | 二 |\n| --- | --- |\n| a | b |');
    const overflowX = await app.window
      .locator('.table-scroll-wrapper')
      .evaluate((el) => getComputedStyle(el).overflowX);
    expect(['auto', 'scroll']).toContain(overflowX);
  });

  test('宽表格布局契约（不换行 + 包裹层自动滚动 + 表撑内容宽）', async () => {
    await loadContent(
      app,
      `| 列一 | 列二 | 列三 |\n| --- | --- | --- |\n| ${'内容内容'.repeat(60)} | B | C |`
    );
    const contract = await app.window.evaluate(() => {
      const table = document.querySelector('.table-scroll-wrapper table') as HTMLElement | null;
      const td = table?.querySelector('tbody td') as HTMLElement | null;
      const wrapper = document.querySelector('.table-scroll-wrapper') as HTMLElement;
      return {
        tableExists: !!table,
        tableDisplay: table ? getComputedStyle(table).display : '',
        tableWidth: table ? getComputedStyle(table).width : '',
        tableMinWidth: table ? getComputedStyle(table).minWidth : '',
        wrapperOverflowX: getComputedStyle(wrapper).overflowX,
        tdWhiteSpace: td ? getComputedStyle(td).whiteSpace : ''
      };
    });
    expect(contract.tableExists).toBe(true);
    expect(contract.tableDisplay).toBe('table');
    // 计算样式会把 width 求值为实际像素，只校验可解析的 min-width 与不换行/滚动契约
    expect(contract.tableMinWidth).toContain('%');
    expect(['auto', 'scroll']).toContain(contract.wrapperOverflowX);
    expect(contract.tdWhiteSpace).toBe('nowrap');
  });

  test('编辑器宽度自适应', async () => {
    const editor = app.window.locator('.ProseMirror');
    const editorBox = await editor.boundingBox();

    expect(editorBox).toBeTruthy();
    if (editorBox) {
      expect(editorBox.width).toBeGreaterThan(0);
      expect(editorBox.height).toBeGreaterThan(0);
    }
  });

  test('编辑器可纵向滚动', async () => {
    await loadContent(app, '');
    await app.window.locator('.ProseMirror').click();
    for (let i = 0; i < 50; i++) {
      await app.window.keyboard.type(`Line ${i + 1}: this is a long test line`);
      await app.window.keyboard.press('Enter');
    }
    await app.window.waitForTimeout(500);

    const hasVerticalScroll = await app.window
      .locator('#editor-container')
      .evaluate((el) => el.scrollHeight > el.clientHeight);

    expect(hasVerticalScroll).toBeTruthy();
  });
});

// ========== 表格交互（表头插入 + 工具条） ==========

/** 合成点击某单元格（与真实点击同一入口：PM 的 handleClick → 选中进入表格） */
async function clickCell(row: number, col: number): Promise<void> {
  await app.window.evaluate(
    ({ r, c }) => {
      const cell = document
        .querySelectorAll('.table-scroll-wrapper table tbody tr')
        [r]?.querySelectorAll('td, th')[c] as HTMLElement | undefined;
      if (!cell) return;
      const rect = cell.getBoundingClientRect();
      const x = rect.left + Math.min(6, rect.width / 2);
      const y = rect.top + Math.min(6, rect.height / 2);
      for (const type of ['pointerdown', 'pointerup', 'click'] as const) {
        cell.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y }));
      }
    },
    { r: row, c: col }
  );
  await app.window.waitForTimeout(300);
}

/** 点击表格工具条的按钮（title 定位） */
async function clickToolButton(title: string): Promise<void> {
  await app.window.evaluate((t) => {
    const btn = [...document.querySelectorAll('#typewren-table-tools button')].find(
      (b) => b.title === t
    ) as HTMLButtonElement | undefined;
    if (btn) btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  }, title);
  await app.window.waitForTimeout(300);
}

/** 读取表头单元格数量 */
function headerCellCount(): Promise<number> {
  return app.window.locator('.table-scroll-wrapper table tr').first().locator('th, td').count();
}

test.describe('表格交互', () => {
  test('插入默认 3 列表格', async () => {
    await loadContent(app, '');
    await app.window.locator('.ProseMirror').click();
    await sendCommand(app, 'insert:table');
    await expect(app.window.locator('.table-scroll-wrapper table')).toHaveCount(1, {
      timeout: 5000
    });

    const headerCells = await headerCellCount();
    const bodyRows = await app.window.locator('.table-scroll-wrapper table tbody tr').count();
    expect(headerCells).toBe(3);
    expect(bodyRows).toBeGreaterThanOrEqual(2);
  });

  test('光标在表格内时工具条可见，可增列', async () => {
    await loadContent(app, '| 一 | 二 |\n| --- | --- |\n| a | b |');
    await clickCell(0, 0);

    const toolbar = app.window.locator('#typewren-table-tools');
    await expect(toolbar).toHaveClass(/visible/, { timeout: 5000 });

    await clickToolButton('在右侧插入列');
    expect(await headerCellCount()).toBe(3);
  });

  test('工具条增行', async () => {
    await loadContent(app, '| 一 | 二 |\n| --- | --- |\n| a | b |');
    await clickCell(0, 0);

    const toolbar = app.window.locator('#typewren-table-tools');
    await expect(toolbar).toHaveClass(/visible/, { timeout: 5000 });
    const rowsBefore = await app.window.locator('.table-scroll-wrapper table tbody tr').count();

    await clickToolButton('在下方插入行');
    const rowsAfter = await app.window.locator('.table-scroll-wrapper table tbody tr').count();
    expect(rowsAfter).toBe(rowsBefore + 1);
  });

  test('工具条删除当前列', async () => {
    await loadContent(app, '| 一 | 二 |\n| --- | --- |\n| a | b |');
    await clickCell(0, 0);

    const toolbar = app.window.locator('#typewren-table-tools');
    await expect(toolbar).toHaveClass(/visible/, { timeout: 5000 });
    await clickToolButton('删除当前列');

    expect(await headerCellCount()).toBe(1);
  });

  test('工具条删除整个表格', async () => {
    await loadContent(app, '| 一 | 二 |\n| --- | --- |\n| a | b |');
    await clickCell(0, 0);

    const toolbar = app.window.locator('#typewren-table-tools');
    await expect(toolbar).toHaveClass(/visible/, { timeout: 5000 });
    await clickToolButton('删除整个表格');

    await expect(app.window.locator('.table-scroll-wrapper table')).toHaveCount(0);
  });
});
