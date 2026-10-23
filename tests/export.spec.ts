import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeApp, launchApp, loadContent, sendCommand, type AppHandle } from './helpers';
import { pngBuffer } from './fixtures/png';

/* ============================================================
 * 导出（HTML / PDF / docx / PNG）
 * --test 模式下导出直写临时目录（typewren-export-test.*），无系统对话框。
 * 导出走主进程隐藏窗口 loadFile 打印/截图，本地图片 src 必须是可加载 URL
 * （相对 ./assets/ 以临时目录为基址必然 404）——回归见"导出图片"用例。
 * ============================================================ */

let app: AppHandle;

const HTML_OUT = join(tmpdir(), 'typewren-export-test.html');
const PDF_OUT = join(tmpdir(), 'typewren-export-test.pdf');
const DOCX_OUT = join(tmpdir(), 'typewren-export-test.docx');
const PNG_OUT = join(tmpdir(), 'typewren-export-test.png');

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
  app = await launchApp();
});

test.afterAll(async () => {
  await closeApp(app);
});

/** 经由主进程菜单命令触发导出（--test 模式直写临时目录，无系统对话框） */
function triggerExport(kind: 'html' | 'pdf' | 'docx' | 'png'): Promise<void> {
  return sendCommand(app, `export:${kind}`);
}

async function expectFileEventually(path: string, verify: (buf: Buffer) => boolean): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          return verify(readFileSync(path));
        } catch {
          return false;
        }
      },
      { timeout: 15000 }
    )
    .toBe(true);
}

test.describe('导出', () => {
  test('导出 HTML 自包含文档', async () => {
    await loadContent(app, SAMPLE_MD);
    try {
      rmSync(HTML_OUT);
    } catch {
      // 文件不存在则忽略
    }
    await triggerExport('html');

    await expectFileEventually(HTML_OUT, (buf) =>
      buf.toString('utf-8').includes('<!DOCTYPE html>')
    );

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

  test('导出 HTML：details 折叠块与答题卡片内容不丢（0.8.0 回归）', async () => {
    const DETAILS_QUIZ_MD = `# 综合

<details>
<summary>点击查看参考答案</summary>

- 归一化通过控制每一层的激活分布

</details>

<script setup>
const quizData = [
  {
    question: '梯度消失问题的根本原因？',
    type: 'single',
    options: [
      { label: 'A', text: '学习率设置太小' },
      { label: 'B', text: '深层的分布失控' }
    ],
    correct: [1],
    explanation: '<strong>正确答案： B</strong>'
  }
]
</script>

<InteractiveQuiz :questions="quizData" quiz-id="normalization" />
`;
    await loadContent(app, DETAILS_QUIZ_MD);
    try {
      rmSync(HTML_OUT);
    } catch {
      // 文件不存在则忽略
    }
    await triggerExport('html');

    await expectFileEventually(HTML_OUT, (buf) =>
      buf.toString('utf-8').includes('<!DOCTYPE html>')
    );
    const html = readFileSync(HTML_OUT, 'utf-8');
    // details：summary 文本 + 内部列表（toDOM 槽位——旧版输出空 details 内容全丢）
    expect(html).toContain('<details');
    expect(html).toContain('点击查看参考答案');
    expect(html).toContain('归一化通过控制每一层的激活分布');
    // 答题卡片：题面与选项进导出（toDOM 静态镜像，旧版输出空 div）
    expect(html).toContain('梯度消失问题的根本原因');
    expect(html).toContain('学习率设置太小');
    expect(html).toContain('深层的分布失控');
  });

  test('导出 PDF 生成有效文件', async () => {
    await loadContent(app, SAMPLE_MD);
    try {
      rmSync(PDF_OUT);
    } catch {
      // 文件不存在则忽略
    }
    await triggerExport('pdf');

    await expectFileEventually(
      PDF_OUT,
      (buf) => buf.length > 1024 && buf.slice(0, 5).toString() === '%PDF-'
    );
  });

  test('导出 docx 生成有效 Word 文件', async () => {
    await loadContent(app, SAMPLE_MD);
    try {
      rmSync(DOCX_OUT);
    } catch {
      // 文件不存在则忽略
    }
    await triggerExport('docx');

    await expectFileEventually(
      DOCX_OUT,
      (buf) => buf.length > 512 && buf.slice(0, 2).toString('latin1') === 'PK'
    );
  });

  test("docx 硬换行是真 <w:br/>（fix 回归：'\\n' 占位在 Word 里不换行）", async () => {
    // 硬换行 = 行尾两空格 + 换行（同一段落内换行）
    await loadContent(app, '第一行内容  \n第二行内容\n');
    try {
      rmSync(DOCX_OUT);
    } catch {
      // 文件不存在则忽略
    }
    await triggerExport('docx');
    await expectFileEventually(
      DOCX_OUT,
      (buf) => buf.length > 512 && buf.slice(0, 2).toString('latin1') === 'PK'
    );

    // 解包 word/document.xml 验证（zip 用 Windows 自带 bsdtar，GNU tar 不认 zip）
    const extractDir = mkdtempSync(join(tmpdir(), 'typewren-docx-br-'));
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    execSync(`"${tar}" -xf "${DOCX_OUT}" -C "${extractDir}" word/document.xml`);
    const xml = readFileSync(join(extractDir, 'word', 'document.xml'), 'utf-8');
    rmSync(extractDir, { recursive: true, force: true });

    // 真 <w:br/> 分隔上下行文本（旧行为是 '\n' 文本 run，Word 里不换行）
    expect(xml).toContain('<w:br/>');
    const para = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/)?.[0] ?? '';
    expect(para).toContain('第一行内容');
    expect(para).toContain('第二行内容');
    expect(para.indexOf('第一行内容')).toBeLessThan(para.indexOf('<w:br/>'));
    expect(para.indexOf('<w:br/>')).toBeLessThan(para.indexOf('第二行内容'));
  });

  test('docx 富结构：链接/引用/任务/有序列表/行内格式全落 XML', async () => {
    const RICH_MD = `# 标题一

普通 **加粗** *斜体* ~~删除~~ \`行码\` 与[链接](https://example.com)。

> 引用段落

- [x] 已完成任务
- [ ] 未完成任务

1. 有序一
2. 有序二

- 普通项

硬上行␣␣
硬下行
`.replace('␣␣', '  ');
    await loadContent(app, RICH_MD);
    try {
      rmSync(DOCX_OUT);
    } catch {
      // 文件不存在则忽略
    }
    await triggerExport('docx');
    await expectFileEventually(
      DOCX_OUT,
      (buf) => buf.length > 512 && buf.slice(0, 2).toString('latin1') === 'PK'
    );

    const extractDir = mkdtempSync(join(tmpdir(), 'typewren-docx-rich-'));
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    execSync(
      `"${tar}" -xf "${DOCX_OUT}" -C "${extractDir}" word/document.xml word/_rels/document.xml.rels`
    );
    const xml = readFileSync(join(extractDir, 'word', 'document.xml'), 'utf-8');
    const rels = readFileSync(join(extractDir, 'word', '_rels', 'document.xml.rels'), 'utf-8');
    rmSync(extractDir, { recursive: true, force: true });

    // 硬换行真 <w:br/>
    expect(xml).toContain('<w:br/>');
    // 任务列表复选标记（退化成普通列表即回归）
    expect(xml).toContain('☑');
    expect(xml).toContain('☐');
    // 有序列表产生 numbering 引用（普通段落无 numPr）
    expect(xml).toContain('<w:numPr>');
    // 引用块缩进 + 左边框（CCCCCI 色）
    expect(xml).toContain('CCCCCC');
    // 行内代码 Consolas、加粗/斜体/删除线的 run 属性
    expect(xml).toContain('Consolas');
    expect(xml).toMatch(/<w:b\/>/);
    expect(xml).toMatch(/<w:i\/>/);
    expect(xml).toMatch(/<w:strike\/>/);
    // 超链接进关系表 + 正文含 hyperlink 元素
    expect(rels).toContain('https://example.com');
    expect(xml).toContain('<w:hyperlink');
  });

  test('export:document 畸形 docxBlocks 防御（归一化丢弃 + toc/默认分支）', async () => {
    const res = await app.window.evaluate(async () => {
      return (
        window as unknown as {
          typewren: {
            exportDocument: (p: unknown) => Promise<{ ok: boolean; canceled: boolean }>;
          };
        }
      ).typewren.exportDocument({
        kind: 'docx',
        html: '',
        suggestedName: 'guard-test.docx',
        docxBlocks: [
          {
            type: 'paragraph',
            runs: [
              { text: 123 },
              null,
              { text: '链接', href: 'https://x.example' },
              { text: '换行', break: true },
              { text: '下划', underline: true },
              { text: '删除', strike: true }
            ],
            level: 0,
            quote: true
          },
          {
            type: 'paragraph',
            runs: [{ text: '任务行', bold: true }],
            level: 0,
            bullet: 'task',
            checked: true
          },
          {
            type: 'paragraph',
            runs: [{ text: '未勾任务', code: true }],
            level: 1,
            bullet: 'task',
            checked: false
          },
          { type: 'paragraph', runs: [{ text: '有序' }], level: 0, bullet: 'ordered' },
          { type: 'paragraph', runs: [{ text: '无序' }], level: 2, bullet: 'bullet' },
          { type: 'paragraph', runs: [{ text: '平段' }], level: 'bad', bullet: 42, quote: 'yes' },
          { type: 'heading', level: 3, runs: [{ text: 'H3' }] },
          { type: 'code', text: 'x = 1', language: 'python' },
          { type: 'table', rows: [[null, [{ text: '格' }], 'junk']], header: false },
          { type: 'toc' },
          { type: 'raw', text: '$$x$$' },
          { type: 'rule' },
          { type: 'weird', text: '默认分支' },
          'junk',
          null,
          { type: 42 }
        ]
      });
    });
    // 全部畸形条目被归一化丢弃，导出仍然成功（不让 docx 库抛错）
    expect(res.ok).toBe(true);
    expect(res.canceled ?? false).toBe(false);
  });

  test('导出 PNG 生成有效图片文件', async () => {
    await loadContent(app, SAMPLE_MD);
    try {
      rmSync(PNG_OUT);
    } catch {
      // 文件不存在则忽略
    }
    await triggerExport('png');

    await expectFileEventually(
      PNG_OUT,
      (buf) => buf.length > 1000 && buf.slice(0, 4).toString('latin1') === 'PNG'
    );
  });
});

// ========== 导出图片（fix 回归：本地图片 src 必须是可加载 URL） ==========

test.describe('导出图片', () => {
  /** 带括号+空格的文档目录：顺带回归引用编码（encodeURI 不转义 ( ) # ? 的老坑） */
  const WORK_DIR = join(tmpdir(), 'typewren-export-img (1)');
  const DOC = join(WORK_DIR, 'doc.md');
  const ASSET = join(WORK_DIR, 'assets', 'pic.png');

  test.beforeAll(() => {
    mkdirSync(join(WORK_DIR, 'assets'), { recursive: true });
    writeFileSync(ASSET, pngBuffer());
    writeFileSync(DOC, '![图](./assets/pic.png)\n', 'utf-8');
  });

  test('导出 HTML 中本地图片 src 为 typewren-img:/data:（相对路径在临时目录必 404）', async () => {
    const content = '![图](./assets/pic.png)\n';
    await loadContent(app, content, DOC);
    try {
      rmSync(HTML_OUT);
    } catch {
      // 文件不存在则忽略
    }
    await triggerExport('html');
    await expectFileEventually(HTML_OUT, (buf) =>
      buf.toString('utf-8').includes('<!DOCTYPE html>')
    );

    const html = readFileSync(HTML_OUT, 'utf-8');
    // 图片 src 已改写为本地协议（或 data:）——绝不保留 ./assets/ 相对引用
    expect(html).not.toContain('src="./assets/');
    const match = html.match(/<img src="([^"]+)"/);
    expect(match).toBeTruthy();
    const src = match![1];
    expect(src.startsWith('typewren-img://local/') || src.startsWith('data:')).toBe(true);
    // 协议 URL 解码后应指向文档同目录 assets/ 的真实文件
    if (src.startsWith('typewren-img://local/')) {
      const decoded = decodeURIComponent(src.slice('typewren-img://local/'.length));
      expect(decoded).toBe(ASSET.replace(/\\/g, '/'));
    }
    // 远程/绝对 URL 不被改写
    await loadContent(app, '![远程](https://example.com/a.png)\n', DOC);
    try {
      rmSync(HTML_OUT);
    } catch {
      // 文件不存在则忽略
    }
    await triggerExport('html');
    await expectFileEventually(HTML_OUT, (buf) =>
      buf.toString('utf-8').includes('<!DOCTYPE html>')
    );
    expect(readFileSync(HTML_OUT, 'utf-8')).toContain('src="https://example.com/a.png"');
  });

  test('docx 结构化导出含表头行、行内代码带 code 样式（fix 回归）', async () => {
    // 拦截主进程的 export:document：docx 是结构化 JSON（主进程才转 .docx），
    // 直接校验渲染层产出的块结构最能锁住表头行/mark 名的回归
    await app.app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { __docxBlocks?: unknown };
      ipcMain.removeHandler('export:document');
      ipcMain.handle('export:document', (_event, payload: unknown) => {
        const p = payload as { docxBlocks?: unknown };
        g.__docxBlocks = p.docxBlocks;
        return { ok: true, canceled: false, path: '' };
      });
    });

    await loadContent(app, '行内 `代码` 内容\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n');
    await triggerExport('docx');

    // 渲染层的 docx 结构是异步经 IPC 送达主进程的，轮询等它落地
    await expect
      .poll(() =>
        app.app.evaluate(() => {
          const g = globalThis as unknown as { __docxBlocks?: unknown };
          return Array.isArray(g.__docxBlocks);
        })
      )
      .toBe(true);

    const blocks = await app.app.evaluate(() => {
      const g = globalThis as unknown as { __docxBlocks?: unknown };
      // 形状：blocks[] → table.rows: 行[] → 单元格[] → run[]（DocxText[][][]）
      return g.__docxBlocks as {
        type: string;
        rows?: { text: string; code?: boolean }[][][];
        runs?: { text: string; code?: boolean }[];
      }[];
    });

    const table = blocks.find((b) => b.type === 'table');
    expect(table).toBeTruthy();
    // 表头行（table_header_row）不再被整行过滤：两行都在
    expect(table!.rows!.length).toBe(2);
    const cellText = (cell: { text: string }[]): string => cell.map((r) => r.text).join('');
    expect(table!.rows![0].map(cellText)).toEqual(['甲', '乙']);
    expect(table!.rows![1].map(cellText)).toEqual(['1', '2']);

    // 行内代码 mark 名是 inlineCode：run.code 必须为 true（拼错则永远无样式）
    const para = blocks.find((b) => b.type === 'paragraph');
    expect(para).toBeTruthy();
    const codeRun = para!.runs!.find((r) => r.text === '代码');
    expect(codeRun).toBeTruthy();
    expect(codeRun!.code).toBe(true);
    const plainRun = para!.runs!.find((r) => r.text.includes('行内'));
    expect(plainRun!.code).toBeFalsy();
  });

  test('docx 含 details summary/内部列表与答题卡片题目选项（0.8.0 回归）', async () => {
    // 拦截 export:document 校验渲染层产出的块结构（与上一用例同一手法，桩自装不依赖顺序）
    await app.app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { __docxBlocks?: unknown };
      g.__docxBlocks = undefined;
      ipcMain.removeHandler('export:document');
      ipcMain.handle('export:document', (_event, payload: unknown) => {
        const p = payload as { docxBlocks?: unknown };
        g.__docxBlocks = p.docxBlocks;
        return { ok: true, canceled: false, path: '' };
      });
    });

    const MD = `# 综合

<details>
<summary>点击查看参考答案</summary>

- 归一化通过控制每一层的激活分布

</details>

<script setup>
const quizData = [
  {
    question: '梯度消失的根本原因？',
    type: 'single',
    options: [
      { label: 'A', text: '学习率太小' },
      { label: 'B', text: '深层分布失控' }
    ],
    correct: [1]
  }
]
</script>

<InteractiveQuiz :questions="quizData" quiz-id="docx" />
`;
    await loadContent(app, MD);
    await triggerExport('docx');

    await expect
      .poll(() =>
        app.app.evaluate(() => {
          const g = globalThis as unknown as { __docxBlocks?: unknown };
          return Array.isArray(g.__docxBlocks);
        })
      )
      .toBe(true);

    const blocks = await app.app.evaluate(() => {
      const g = globalThis as unknown as {
        __docxBlocks?: { type: string; runs?: { text: string }[] }[];
      };
      return g.__docxBlocks!;
    });
    const texts = blocks.map((b) => (b.runs ?? []).map((r) => r.text).join(''));
    // details：summary 是属性，旧版直接下探整条丢；内部列表随容器下探导出
    expect(texts.some((t) => t.includes('点击查看参考答案'))).toBe(true);
    expect(texts.some((t) => t.includes('归一化通过控制每一层的激活分布'))).toBe(true);
    // 答题卡片：原子节点旧版整卡丢——题面与选项都要进导出
    expect(texts.some((t) => t.includes('梯度消失的根本原因'))).toBe(true);
    expect(texts.some((t) => t.includes('学习率太小'))).toBe(true);
    expect(texts.some((t) => t.includes('深层分布失控'))).toBe(true);
  });
});
