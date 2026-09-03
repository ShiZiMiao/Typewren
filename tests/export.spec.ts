import { test, expect, _electron as electron } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Awaited<ReturnType<typeof electronApp.firstWindow>>;

const HTML_OUT = join(tmpdir(), 'typewren-export-test.html');
const PDF_OUT = join(tmpdir(), 'typewren-export-test.pdf');

/** 覆盖标题/公式/表格/任务列表/代码块/引用的样例文档 */
const SAMPLE_MD = `# 导出测试

使用 **加粗**、*斜体* 与 \`行内代码\`。

| 列一 | 列二 |
| --- | --- |
| A | B |

- [x] 已完成任务
- [ ] 未完成任务

\`\`\`typescript
const answer: number = 42
\`\`\`

行内公式 $e^{i\\pi} + 1 = 0$ 与块级公式：

$$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
$$
`;

test.beforeAll(async () => {
  electronApp = await electron.launch({
    args: ['--test', join(__dirname, '../out/main/index.js')]
  });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForSelector('.ProseMirror', { timeout: 10000 });
  await window.waitForTimeout(1000);
});

test.afterAll(async () => {
  await electronApp.close();
});

/** 经主进程注入文档内容（走 open-file-path 正常加载流程） */
function loadSampleDocument(): Promise<void> {
  return electronApp.evaluate(({ BrowserWindow }, content) => {
    BrowserWindow.getAllWindows()[0].webContents.send('cmd', 'open-file-path', {
      path: '',
      content
    });
  }, SAMPLE_MD);
}

/** 经由主进程菜单命令触发导出（--test 模式直写临时目录，无系统对话框） */
function triggerExport(kind: 'html' | 'pdf'): Promise<void> {
  return electronApp.evaluate(({ BrowserWindow }, command) => {
    BrowserWindow.getAllWindows()[0].webContents.send('cmd', command);
  }, `export:${kind}`);
}

test.describe('导出', () => {
  test('导出 HTML 自包含文档', async () => {
    await loadSampleDocument();
    // 等文档内容真正加载到编辑器中（open-file-path 为异步事务）
    await window.waitForSelector('.ProseMirror h1', { timeout: 5000 });
    try {
      rmSync(HTML_OUT);
    } catch {
      // 文件不存在则忽略
    }
    await triggerExport('html');

    await expect
      .poll(() => {
        try {
          return readFileSync(HTML_OUT, 'utf-8').includes('<!DOCTYPE html>');
        } catch {
          return false;
        }
      })
      .toBe(true);

    const html = readFileSync(HTML_OUT, 'utf-8');
    // 编辑器主题与排版样式已内联
    expect(html).toContain('data-theme=');
    expect(html).toContain('.ProseMirror');
    // 各元素均被渲染
    expect(html).toContain('<h1');
    expect(html).toContain('<table');
    expect(html).toContain('data-item-type="task"');
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('const');
    // 公式已由 KaTeX 渲染
    expect(html).toContain('class="katex');
    // KaTeX 字体已内联为 data URI，自包含无外部引用
    expect(html).toContain('data:font/woff2;base64,');
    expect(html).not.toContain('url(fonts/');
  });

  test('导出 PDF 生成有效文件', async () => {
    await loadSampleDocument();
    await window.waitForSelector('.ProseMirror h1', { timeout: 5000 });
    try {
      rmSync(PDF_OUT);
    } catch {
      // 文件不存在则忽略
    }
    await triggerExport('pdf');

    await expect
      .poll(() => {
        try {
          const buf = readFileSync(PDF_OUT);
          return buf.length > 1024 && buf.slice(0, 5).toString() === '%PDF-';
        } catch {
          return false;
        }
      })
      .toBe(true);
  });
});
