import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { readFileSync, readdirSync, promises as fsp } from 'node:fs';
import { join } from 'node:path';

import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  BorderStyle,
  AlignmentType,
  ExternalHyperlink
} from 'docx';

import type { ExportDocumentPayload, ExportDocumentResult } from '../shared/ipc';
import { isExportDocumentPayload } from '../shared/ipc';
import { isTestMode } from './runMode';

/* ============================================================
 * 导出 PDF / HTML / Docx / PNG（主进程侧）
 * 渲染层已拼好完整 HTML 页面（内联样式 + KaTeX 渲染结果），
 * 这里负责：另存为对话框 → KaTeX 字体内联（自包含）→ 写盘 / 打印。
 * docx 由渲染层传入结构化块（docxExport.ts），此处用 docx 库构造；
 * png 复用导出 HTML 由隐藏窗口整页截图。
 * ============================================================ */

interface DocxTextLike {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  underline?: boolean;
  href?: string;
}

interface DocxBlockLike {
  type: string;
  level?: number;
  runs?: DocxTextLike[];
  bullet?: string;
  checked?: boolean;
  quote?: boolean;
  text?: string;
  language?: string;
  rows?: DocxTextLike[][][];
  header?: boolean;
}

function runOf(t: DocxTextLike): TextRun {
  return new TextRun({
    text: t.text,
    bold: t.bold,
    italics: t.italic,
    strike: t.strike,
    underline: t.underline ? { type: 'single' } : undefined,
    // 行内代码：docx 无法方便设等宽字体字距，用 Consolas 近似
    font: t.code ? 'Consolas' : undefined
  });
}

/** 行内 run 逐字段 shape 归一（IPC 载荷不可信：畸形字段丢弃，不让 docx 库抛错） */
function normalizeRuns(value: unknown): DocxTextLike[] {
  if (!Array.isArray(value)) return [];
  const out: DocxTextLike[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const run: DocxTextLike = { text: typeof r.text === 'string' ? r.text : '' };
    if (typeof r.bold === 'boolean') run.bold = r.bold;
    if (typeof r.italic === 'boolean') run.italic = r.italic;
    if (typeof r.strike === 'boolean') run.strike = r.strike;
    if (typeof r.code === 'boolean') run.code = r.code;
    if (typeof r.underline === 'boolean') run.underline = r.underline;
    if (typeof r.href === 'string') run.href = r.href;
    out.push(run);
  }
  return out;
}

/** docxBlocks 逐层 shape 归一：块/行内 run 的字段一律按 typeof 归一，
 *  类型不对的字段丢弃或回落默认值（渲染层载荷经 IPC 可能被篡改/畸形，
 *  裸 `as DocxBlockLike[]` 会把任意对象交给 docx 库构造，异常难定位） */
function normalizeDocxBlocks(value: unknown): DocxBlockLike[] {
  if (!Array.isArray(value)) return [];
  const blocks: DocxBlockLike[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const b = raw as Record<string, unknown>;
    const block: DocxBlockLike = { type: typeof b.type === 'string' ? b.type : 'paragraph' };
    if (typeof b.level === 'number') block.level = b.level;
    if (b.runs !== undefined) block.runs = normalizeRuns(b.runs);
    if (typeof b.bullet === 'string') block.bullet = b.bullet;
    if (typeof b.checked === 'boolean') block.checked = b.checked;
    if (typeof b.quote === 'boolean') block.quote = b.quote;
    if (typeof b.text === 'string') block.text = b.text;
    if (typeof b.language === 'string') block.language = b.language;
    if (typeof b.header === 'boolean') block.header = b.header;
    if (Array.isArray(b.rows)) {
      block.rows = b.rows.map((row) => (Array.isArray(row) ? row.map(normalizeRuns) : []));
    }
    blocks.push(block);
  }
  return blocks;
}

function runsOf(runs: DocxTextLike[] = []): (TextRun | ExternalHyperlink)[] {
  const out: (TextRun | ExternalHyperlink)[] = [];
  for (const t of runs) {
    if (t.href) {
      out.push(
        new ExternalHyperlink({
          link: t.href,
          children: [new TextRun({ text: t.text, style: 'Hyperlink' })]
        })
      );
    } else {
      out.push(runOf(t));
    }
  }
  return out;
}

function paragraphOf(block: DocxBlockLike): Paragraph {
  if (block.quote) {
    return new Paragraph({
      children: runsOf(block.runs),
      indent: { left: 720 },
      border: {
        left: { style: BorderStyle.SINGLE, size: 12, color: 'CCCCCC', space: 6 }
      }
    });
  }

  if (block.bullet === 'task') {
    const mark = block.checked ? '☑ ' : '☐ ';
    return new Paragraph({
      children: [new TextRun({ text: mark }), ...runsOf(block.runs)],
      bullet: { level: block.level ?? 0 }
    });
  }

  if (block.bullet === 'ordered') {
    return new Paragraph({
      children: runsOf(block.runs),
      numbering: {
        reference: 'ordered-list',
        level: block.level ?? 0
      }
    });
  }

  if (block.bullet === 'bullet') {
    return new Paragraph({
      children: runsOf(block.runs),
      bullet: { level: block.level ?? 0 }
    });
  }

  return new Paragraph({ children: runsOf(block.runs) });
}

function tableOf(block: DocxBlockLike): Table {
  const rows = (block.rows ?? []).map(
    (cells, rowIndex) =>
      new TableRow({
        children: cells.map(
          (cell) =>
            new TableCell({
              width: { size: 20, type: WidthType.PERCENTAGE },
              children: [
                new Paragraph({
                  children: runsOf(cell),
                  shading:
                    rowIndex === 0 && block.header
                      ? { fill: 'F2F2F2', type: 'clear', color: 'auto' }
                      : undefined
                })
              ]
            })
        )
      })
  );
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE }
  });
}

function codeParagraphs(block: DocxBlockLike): Paragraph[] {
  const lines = (block.text ?? '').split('\n');
  return lines.map(
    (line) =>
      new Paragraph({
        children: [new TextRun({ text: line, font: 'Consolas', size: 18 })],
        spacing: { after: 0 },
        shading: { fill: 'F5F5F5', type: 'clear', color: 'auto' },
        indent: { left: 360 }
      })
  );
}

function headingOf(block: DocxBlockLike): Paragraph {
  const map: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
    5: HeadingLevel.HEADING_5,
    6: HeadingLevel.HEADING_6
  };
  return new Paragraph({
    children: runsOf(block.runs),
    heading: map[block.level ?? 1] ?? HeadingLevel.HEADING_1
  });
}

function buildDocxDoc(blocks: DocxBlockLike[]): Document {
  const children: (Paragraph | Table)[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        children.push(headingOf(block));
        break;
      case 'paragraph':
        children.push(paragraphOf(block));
        break;
      case 'code':
        children.push(...codeParagraphs(block));
        break;
      case 'table':
        children.push(tableOf(block));
        break;
      case 'toc':
        children.push(
          new Paragraph({
            children: [new TextRun({ text: '[目录，请用 Word 更新域]', italics: true })],
            spacing: { before: 200, after: 200 }
          })
        );
        break;
      default:
        children.push(new Paragraph({ children: [new TextRun({ text: block.text ?? '' })] }));
        break;
    }
  }

  return new Document({
    numbering: {
      config: [
        {
          reference: 'ordered-list',
          levels: [
            {
              level: 0,
              format: 'decimal',
              text: '%1.',
              alignment: AlignmentType.START,
              style: {
                paragraph: { indent: { left: 720, hanging: 360 } }
              }
            },
            {
              level: 1,
              format: 'lowerLetter',
              text: '%2.',
              alignment: AlignmentType.START,
              style: {
                paragraph: { indent: { left: 1440, hanging: 360 } }
              }
            },
            {
              level: 2,
              format: 'lowerRoman',
              text: '%3.',
              alignment: AlignmentType.START,
              style: {
                paragraph: { indent: { left: 2160, hanging: 360 } }
              }
            }
          ]
        }
      ]
    },
    sections: [
      {
        properties: {},
        children
      }
    ],
    styles: {
      default: {
        document: {
          run: {
            font: 'Calibri',
            size: 22
          },
          paragraph: {
            spacing: { line: 300 }
          }
        }
      }
    }
  });
}

/** 导出对话框过滤器 */
function exportFilters(kind: ExportDocumentPayload['kind']): Electron.FileFilter[] {
  switch (kind) {
    case 'pdf':
      return [{ name: 'PDF 文档', extensions: ['pdf'] }];
    case 'docx':
      return [{ name: 'Word 文档', extensions: ['docx'] }];
    case 'png':
      return [{ name: 'PNG 图片', extensions: ['png'] }];
    default:
      return [{ name: 'HTML 文档', extensions: ['html'] }];
  }
}

/** 对话框返回的路径未带扩展名时补全 */
function ensureExtension(filePath: string, kind: ExportDocumentPayload['kind']): string {
  const ext =
    kind === 'pdf' ? '.pdf' : kind === 'docx' ? '.docx' : kind === 'png' ? '.png' : '.html';
  return new RegExp(`\\${ext}$`, 'i').test(filePath) ? filePath : `${filePath}${ext}`;
}

function showExportDialog(
  win: BrowserWindow | null,
  payload: ExportDocumentPayload
): Promise<Electron.SaveDialogReturnValue> {
  const titleMap: Record<ExportDocumentPayload['kind'], string> = {
    pdf: '导出为 PDF',
    html: '导出为 HTML',
    docx: '导出为 Word 文档',
    png: '导出为图片（PNG）'
  };
  const options: Electron.SaveDialogOptions = {
    title: titleMap[payload.kind],
    defaultPath: payload.suggestedName,
    filters: exportFilters(payload.kind)
  };
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options);
}

/** KaTeX 字体目录：dev/打包从 app 根解析，测试进程（入口在 out/ 下）回退到项目根 */
function katexFontsDir(): string | null {
  const candidates = [
    join(app.getAppPath(), 'node_modules', 'katex', 'dist', 'fonts'),
    join(process.cwd(), 'node_modules', 'katex', 'dist', 'fonts')
  ];
  for (const dir of candidates) {
    try {
      if (readdirSync(dir).length > 0) return dir;
    } catch {
      // 该候选不存在，尝试下一项
    }
  }
  return null;
}

/**
 * 把导出页内 KaTeX 的 url(fonts/…) 引用替换为 base64 data URI，
 * 并移除 woff/ttf 冗余段（仅保留 woff2），使导出的 HTML/PDF 自包含、离线可渲染。
 * 字体目录不可用时原样返回（公式退回系统字体兜底）。
 */
function embedKatexFonts(html: string): string {
  const fontsDir = katexFontsDir();
  if (!fontsDir) return html;
  const available = new Set(readdirSync(fontsDir));

  let result = html.replace(/url\(fonts\/([A-Za-z0-9_.-]+\.woff2)\)/g, (match, name: string) => {
    if (!available.has(name)) return match;
    const font = readFileSync(join(fontsDir, name)).toString('base64');
    return `url(data:font/woff2;base64,${font})`;
  });
  // 去掉已内联的 woff2 之外的冗余源（两轮覆盖 woff→ttf 的链式引用）
  const dropLegacy =
    /\s*,?\s*url\(fonts\/[A-Za-z0-9_.-]+\.(?:woff|ttf)\)\s*format\((?:'[^']*'|"[^"]*")\),?/g;
  result = result.replace(dropLegacy, '');
  result = result.replace(dropLegacy, '');
  return result;
}

/** 把完整 HTML 打印成 PDF：临时文件 → 隐藏窗口 → printToPDF → 写盘 */
async function printHtmlToPdf(html: string, destPath: string): Promise<void> {
  const tempDir = await fsp.mkdtemp(join(app.getPath('temp'), 'typewren-export-'));
  let printWin: BrowserWindow | null = null;
  try {
    const tempHtml = join(tempDir, 'export.html');
    await fsp.writeFile(tempHtml, html, 'utf-8');

    printWin = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    await printWin.loadFile(tempHtml);
    const pdf = await printWin.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true
    });
    await fsp.writeFile(destPath, pdf);
  } finally {
    printWin?.destroy();
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * 等导出页渲染就绪再截图：KaTeX 字体 + 全部 <img> 解码完成。
 * 固定 150ms 等待在慢机器上会截到半成品（字体未替换/图片未解码）；
 * executeJavaScript 轮询就绪信号，超时兜底（外链图失败不能把导出挂死）。
 */
async function waitForRenderReady(contents: Electron.WebContents, timeoutMs = 5000): Promise<void> {
  await contents.executeJavaScript(`
    Promise.race([
      (async () => {
        if (document.fonts && document.fonts.ready) { await document.fonts.ready; }
        await Promise.all(Array.from(document.images).map((img) =>
          typeof img.decode === 'function'
            ? img.decode().catch(() => {})
            : (img.complete
                ? Promise.resolve()
                : new Promise((r) => { img.onload = r; img.onerror = r; }))
        ));
      })(),
      new Promise((r) => setTimeout(r, ${timeoutMs}))
    ])
  `);
}

/** executeJavaScript 返回值归一：非数字/NaN/Infinity 回退默认（页面可能产出任意 JS 值） */
function normalizeSize(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 整页 PNG 截图：隐藏窗口加载导入 HTML，把窗口拉到文档高度后 capturePage。
 * 长文档超出单屏高度限制时按窗口可支持的最大高度截取（保底不失败）。
 */
async function captureHtmlToPng(html: string, destPath: string): Promise<void> {
  const tempDir = await fsp.mkdtemp(join(app.getPath('temp'), 'typewren-export-'));
  let shotWin: BrowserWindow | null = null;
  try {
    const tempHtml = join(tempDir, 'export.html');
    await fsp.writeFile(tempHtml, html, 'utf-8');
    // 图片用白底（不依赖应用主题），避免暗色主题下导出"黑图"
    shotWin = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      backgroundColor: '#ffffff',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    await shotWin.loadFile(tempHtml);
    // 等字体/图片就绪（固定等待改就绪轮询，见函数注释）
    await waitForRenderReady(shotWin.webContents);

    const height = normalizeSize(
      await shotWin.webContents.executeJavaScript(
        'Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)'
      ),
      800
    );
    const width = Math.max(
      1200,
      normalizeSize(
        await shotWin.webContents.executeJavaScript(
          'Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0)'
        ),
        1200
      )
    );
    // 窗口高度上限（Windows 单屏约 16k，留安全边际；超出部分截断）
    const boundedHeight = Math.min(Math.max(height, 800), 15000);
    shotWin.setContentSize(width, boundedHeight);
    // setContentSize 后的重排/重绘稳定等待（短固定等待可接受；
    // 字体与图片就绪已在上面等过，这里只是布局落定）
    await shotWin.webContents.executeJavaScript('new Promise((r) => setTimeout(r, 120))');

    const image = await shotWin.webContents.capturePage();
    const buffer = image.toPNG();
    await fsp.writeFile(destPath, buffer);
  } finally {
    shotWin?.destroy();
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

/** 注册导出 IPC：弹另存为对话框并完成 HTML 写盘 / PDF 打印 / Docx 生成 / PNG 截图 */
export function registerExportHandlers(): void {
  ipcMain.handle(
    'export:document',
    async (event, payload: ExportDocumentPayload): Promise<ExportDocumentResult> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!isExportDocumentPayload(payload)) {
        return { ok: false, error: '无效的导出参数' };
      }

      // 测试模式跳过系统对话框，直接写入临时目录（供 e2e 断言导出产物）
      const destPath = isTestMode()
        ? join(
            app.getPath('temp'),
            payload.kind === 'pdf'
              ? 'typewren-export-test.pdf'
              : payload.kind === 'html'
                ? 'typewren-export-test.html'
                : payload.kind === 'docx'
                  ? 'typewren-export-test.docx'
                  : 'typewren-export-test.png'
          )
        : await pickExportPath(win, payload);
      if (!destPath) return { ok: false, canceled: true };

      try {
        if (payload.kind === 'docx') {
          // 逐层 shape 守卫（见 normalizeDocxBlocks）：不把裸断言的任意外构交给 docx 库
          const doc = buildDocxDoc(normalizeDocxBlocks(payload.docxBlocks));
          const buffer = await Packer.toBuffer(doc);
          await fsp.writeFile(destPath, buffer);
        } else {
          const html = embedKatexFonts(payload.html);
          if (payload.kind === 'pdf') {
            await printHtmlToPdf(html, destPath);
          } else if (payload.kind === 'png') {
            await captureHtmlToPng(html, destPath);
          } else {
            await fsp.writeFile(destPath, html, 'utf-8');
          }
        }
        return { ok: true };
      } catch (error) {
        const labelMap: Record<ExportDocumentPayload['kind'], string> = {
          pdf: 'PDF',
          html: 'HTML',
          docx: 'Word 文档',
          png: 'PNG 图片'
        };
        dialog.showErrorBox('导出失败', `${labelMap[payload.kind]} 导出失败：\n${String(error)}`);
        return { ok: false, error: String(error) };
      }
    }
  );
}

/** 弹原生另存为对话框；取消返回 null */
async function pickExportPath(
  win: BrowserWindow | null,
  payload: ExportDocumentPayload
): Promise<string | null> {
  const dialogResult = await showExportDialog(win, payload);
  if (dialogResult.canceled || !dialogResult.filePath) return null;
  return ensureExtension(dialogResult.filePath, payload.kind);
}
