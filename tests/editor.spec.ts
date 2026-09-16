import { test, expect } from '@playwright/test';
import { launchApp, closeApp, loadContent, sendCommand, type AppHandle } from './helpers';

let app: AppHandle;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await closeApp(app);
});

/** 读取渲染视图序列化结果：进入源码模式取 textarea 内容（等价 getMarkdown） */
async function serializedMarkdown(): Promise<string> {
  await sendCommand(app, 'view:source');
  const text = await app.window.locator('#source-textarea').textContent();
  await sendCommand(app, 'view:source');
  return text ?? '';
}

// ========== 编辑器渲染 ==========

test.describe('编辑器渲染', () => {
  test('标题 1-6 级渲染', async () => {
    await loadContent(
      app,
      '# 一级\n\n## 二级\n\n### 三级\n\n#### 四级\n\n##### 五级\n\n###### 六级'
    );
    for (let level = 1; level <= 6; level++) {
      await expect(app.window.locator(`.ProseMirror h${level}`)).toHaveCount(1);
    }
  });

  test('行内格式渲染', async () => {
    await loadContent(app, '**加粗** *斜体* ~~删除线~~ `行内代码` [链接](https://example.com)');
    await expect(app.window.locator('.ProseMirror strong')).toHaveCount(1);
    await expect(app.window.locator('.ProseMirror em')).toHaveCount(1);
    await expect(app.window.locator('.ProseMirror del')).toHaveCount(1);
    await expect(app.window.locator('.ProseMirror code')).toHaveCount(1);
    await expect(app.window.locator('.ProseMirror a[href="https://example.com"]')).toHaveCount(1);
  });

  test('三类列表渲染', async () => {
    await loadContent(
      app,
      '- 无序一\n- 无序二\n\n1. 有序一\n2. 有序二\n\n- [x] 已完成\n- [ ] 未完成'
    );
    await expect(app.window.locator('.ProseMirror ul')).toHaveCount(2);
    await expect(app.window.locator('.ProseMirror ol')).toHaveCount(1);
    await expect(app.window.locator('.ProseMirror li[data-item-type="task"]')).toHaveCount(2);
    await expect(
      app.window.locator('.ProseMirror li[data-item-type="task"][data-checked="true"]')
    ).toHaveCount(1);
  });

  test('引用块渲染', async () => {
    await loadContent(app, '> 引用内容');
    await expect(app.window.locator('.ProseMirror blockquote')).toHaveCount(1);
    await expect(app.window.locator('.ProseMirror blockquote')).toContainText('引用内容');
  });

  test('代码块高亮渲染', async () => {
    await loadContent(app, '```typescript\nconst answer: number = 42\nconsole.log(answer)\n```');
    const pre = app.window.locator('.ProseMirror pre');
    await expect(pre).toHaveCount(1);
    await expect(pre.locator('code')).toHaveCount(1);
    // 语法高亮由 prosemirror-highlight 以行内 span 装饰（语言标签写在装饰里）
    await expect(pre.locator('.hljs-keyword')).toHaveCount(1, { timeout: 10000 });
  });

  test('数学公式渲染（行内 + 块级）', async () => {
    await loadContent(
      app,
      '行内公式 $x^2 + y^2 = z^2$ 与块级公式：\n\n$$\n\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}\n$$'
    );
    await expect(app.window.locator('.typewren-math-inline .katex')).toHaveCount(1);
    await expect(app.window.locator('.typewren-math-block .katex')).toHaveCount(1);
  });

  test('Mermaid 图表渲染（```mermaid 代码块转 SVG）', async () => {
    await loadContent(
      app,
      '上方文字\n\n```mermaid\ngraph TD;\n  A[开始] --> B{判断};\n  B -->|是| C[结束];\n```'
    );
    const block = app.window.locator('.typewren-mermaid-block');
    await expect(block).toHaveCount(1);
    // mermaid 懒加载 + 异步渲染，放宽超时
    await expect(block.locator('svg')).toHaveCount(1, { timeout: 20000 });
    // 源码内容保留在 data 属性（序列化往返无损）
    await expect(block).toHaveAttribute('data-mermaid-value', /graph TD/);
    // 编辑后源码模式往返仍是 mermaid 块而非高亮代码块
    await sendCommand(app, 'view:source');
    await app.window.waitForTimeout(200);
    await expect(app.window.locator('#source-textarea')).toContainText('```mermaid');
    await sendCommand(app, 'view:source');
    await app.window.waitForTimeout(200);
    await expect(app.window.locator('.typewren-mermaid-block svg')).toHaveCount(1, {
      timeout: 20000
    });
  });

  test('Mermaid 图表源码编辑：选中节点改源码', async () => {
    await loadContent(app, '```mermaid\ngraph TD;\n  A --> B;\n```');
    const block = app.window.locator('.typewren-mermaid-block');
    await expect(block.locator('svg')).toHaveCount(1, { timeout: 20000 });
    // 点击选中 → 出源码编辑框
    await block.click();
    await app.window.waitForTimeout(200);
    const editor = block.locator('.math-src-editor');
    await expect(editor).toBeVisible();
    // 改源码后点其它地方失焦提交
    await editor.fill('graph LR;\n  X --> Y;');
    await app.window.locator('.ProseMirror h1, .ProseMirror p').first().click();
    await app.window.waitForTimeout(800);
    await expect(block.locator('svg')).toHaveCount(1, { timeout: 20000 });
  });

  test('脚注渲染与序列化往返（[^id] 引用 + 定义）', async () => {
    const md = '正文[^1] 继续[^a]\n\n[^1]: 第一条脚注\n[^a]: 第二条脚注\n';
    await loadContent(app, md);
    await expect(app.window.locator('sup[data-type="footnote_reference"]')).toHaveCount(2);
    await expect(app.window.locator('dl[data-type="footnote_definition"]')).toHaveCount(2);
    // 序列化往返不丢脚注
    await sendCommand(app, 'view:source');
    await app.window.waitForTimeout(200);
    await expect(app.window.locator('#source-textarea')).toContainText('[^1]: 第一条脚注');
    await sendCommand(app, 'view:source');
    await app.window.waitForTimeout(200);
    await expect(app.window.locator('sup[data-type="footnote_reference"]')).toHaveCount(2);
  });

  test('目录 [TOC] 渲染层级列表并点击跳转', async () => {
    const md = '[TOC]\n\n# 一级甲\n\n## 二级甲\n\n## 二级乙\n\n### 三级甲\n\n# 一级乙\n';
    await loadContent(app, md);
    const toc = app.window.locator('.typewren-toc');
    await expect(toc).toHaveCount(1);
    await expect(toc.locator('.toc-item')).toHaveCount(5);
    // 嵌套层级：二级项应有更深的 ul
    await expect(toc.locator('.toc-list > ul > li > ul > li > ul')).toHaveCount(1);
    // 点击跳转：点击"一级乙" → 文档滚动到该标题（标题进入视口）
    await toc.locator('.toc-item', { hasText: '一级乙' }).click();
    await app.window.waitForTimeout(400);
    const visible = await app.window.evaluate(() => {
      const el = document.querySelector('.ProseMirror h1:last-of-type');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.top < window.innerHeight;
    });
    expect(visible).toBe(true);
  });

  test('块级公式上下限不被容器 overflow 裁切（回归 #katex-display）', async () => {
    // KaTeX 0.18 用绝对定位（.vlist）绘制积分上下限，墨迹会顶出 .katex 盒子上沿；
    // 历史上 .katex-display 上的 overflow-x:auto 连带把 overflow-y 计算为 auto，
    // 把 ∞ 顶部整段裁掉。断言：每个裁切容器（非 visible overflow）的内缘都容得下墨迹。
    await loadContent(app, '$$\n\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}\n$$');
    await expect(app.window.locator('.typewren-math-block .katex')).toHaveCount(1);

    const clipped = await app.window.evaluate(() => {
      const block = document.querySelector('.typewren-math-block');
      if (!block) return ['no-block'];
      // 收集块级公式里真实携带文字的墨迹范围（pstrut/strut 是零宽占位，不算），
      // 并记住最顶墨迹所属元素——裁切检测要从它向上走
      const range = document.createRange();
      let inkTop = Infinity;
      let inkNode: Node | null = null;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent || !n.textContent.trim()) continue;
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.top < inkTop) {
          inkTop = r.top;
          inkNode = n;
        }
      }
      if (!inkNode) return ['no-ink'];
      // 从墨迹元素逐层向上找裁切容器（overflow 非 visible），比较裁切内缘与墨迹顶。
      // 注意 .katex-display 位于块内部（墨迹的祖先、块的子孙），必须从墨迹出发
      const offenders: string[] = [];
      for (let cur: Element | null = inkNode.parentElement; cur; cur = cur.parentElement) {
        const cs = getComputedStyle(cur);
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
          const rect = cur.getBoundingClientRect();
          const cutTop = rect.top + parseFloat(cs.borderTopWidth);
          if (inkTop < cutTop - 0.5) {
            const tag = cur.className || cur.tagName;
            offenders.push(`${tag}: ink ${inkTop.toFixed(1)} < cut ${cutTop.toFixed(1)}`);
          }
        }
      }
      return offenders;
    });
    expect(clipped).toEqual([]);
  });

  test('水平线渲染', async () => {
    await loadContent(app, '上方\n\n---\n\n下方');
    await expect(app.window.locator('.ProseMirror hr')).toHaveCount(1);
  });

  test('空文档显示占位状态', async () => {
    await loadContent(app, '');
    await expect(app.window.locator('.ProseMirror.is-doc-empty')).toBeVisible({ timeout: 5000 });
  });

  test('序列化往返：渲染 → 源码一致', async () => {
    const md = '# 标题\n\n**加粗** 与 [链接](https://x.com)\n\n- 列表项\n\n```js\nconst a = 1\n```';
    await loadContent(app, md);

    // 干净态源码视图显示磁盘原文（不做序列化改写：- 列表项 保持连字符）
    const src = await serializedMarkdown();
    expect(src).toContain('# 标题');
    expect(src).toContain('**加粗**');
    expect(src).toContain('[链接](https://x.com)');
    expect(src).toContain('- 列表项');
    expect(src).toContain('```js');
  });

  test('中文与特殊字符不损坏', async () => {
    await loadContent(app, '中文内容 <tag> &amp; "引号" \'单引号\'\n\n`code<>&`');
    const src = await serializedMarkdown();
    expect(src).toContain('中文内容');
    expect(src).toContain('<tag>');
    expect(src).toContain('code<>&');
  });
});

// ========== 任务列表 ==========

test.describe('任务列表', () => {
  test('勾选热区点击翻转任务', async () => {
    await loadContent(app, '- [ ] 待办事项');
    const task = app.window.locator('.ProseMirror li[data-item-type="task"]').first();
    await expect(task).toHaveAttribute('data-checked', 'false');

    // 左侧 30px 勾选框热区
    await task.click({ position: { x: 8, y: 10 } });
    await expect(task).toHaveAttribute('data-checked', 'true', { timeout: 5000 });

    // 序列化同步为 [x]（序列化对任务列表使用 * 前缀，匹配记号即可）
    const src = await serializedMarkdown();
    expect(src).toMatch(/\[x\] 待办事项/);
    expect(src).not.toMatch(/\[ \] 待办事项/);
  });

  test('点击非热区不翻转', async () => {
    await loadContent(app, '- [ ] 待办任务');
    const li = app.window.locator('.ProseMirror li[data-item-type="task"]').first();
    await li.click({ position: { x: 120, y: 10 } });
    await app.window.waitForTimeout(300);
    await expect(li).toHaveAttribute('data-checked', 'false');
  });
});

// ========== 数学公式输入 ==========

test.describe('数学公式输入', () => {
  test('输入 $..$ 触发行内公式输入规则', async () => {
    await loadContent(app, '');
    await app.window.locator('.ProseMirror').click();
    await app.window.keyboard.type('公式 $\\alpha$ 测试');
    await expect(app.window.locator('.typewren-math-inline .katex')).toHaveCount(1, {
      timeout: 5000
    });

    const src = await serializedMarkdown();
    expect(src).toContain('\\alpha');
  });

  test('插入空块级公式并提交 LaTeX', async () => {
    await loadContent(app, '下方文本段落');
    await app.window.locator('.ProseMirror').click();
    // 等 PM 处理完 click 的选区落位再发命令（无头下组内时序更紧，防止
    // block:math 抢在选区更新前执行导致插入点错位）
    await app.window.waitForTimeout(150);
    await sendCommand(app, 'block:math');

    // 无头窗口下节点视图创建可能慢一帧：先等节点出现，再等源码编辑框进入编辑态
    await expect(app.window.locator('.typewren-math-block')).toHaveCount(1, { timeout: 5000 });
    const editorEl = app.window.locator('.typewren-math-block .math-src-editor');
    await expect(editorEl).toBeVisible({ timeout: 5000 });
    await editorEl.fill('\\frac{1}{2}');
    await editorEl.press('Escape');
    // 点击文本段落取消公式选中态，节点退出编辑态渲染 KaTeX
    await app.window
      .locator('.ProseMirror p')
      .first()
      .click({ position: { x: 8, y: 8 } });

    await expect(app.window.locator('.typewren-math-block .math-rendered .katex')).toBeVisible({
      timeout: 5000
    });

    const src = await serializedMarkdown();
    expect(src).toContain('\\frac{1}{2}');
  });

  test('插入行内公式：Enter 提交', async () => {
    await loadContent(app, '段落文本');
    await app.window.locator('.ProseMirror').click();
    await sendCommand(app, 'block:math-inline');

    const editorEl = app.window.locator('.typewren-math-inline .math-src-editor');
    await expect(editorEl).toBeVisible({ timeout: 5000 });
    await editorEl.fill('E=mc^2');
    await editorEl.press('Enter');
    // 点击文本取消选中态后渲染
    await app.window.locator('.ProseMirror p').click({ position: { x: 8, y: 8 } });

    await expect(app.window.locator('.typewren-math-inline .math-rendered .katex')).toBeVisible({
      timeout: 5000
    });
  });
});
