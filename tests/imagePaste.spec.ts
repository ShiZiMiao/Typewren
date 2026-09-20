import { test, expect, _electron as electron } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Awaited<ReturnType<typeof electronApp.firstWindow>>;

const WORK_DIR = join(tmpdir(), 'typewren-img-test');
const DOC_PATH = join(WORK_DIR, 'doc.md');
/** 1x1 透明 PNG */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function ensureDoc(): void {
  if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true });
  if (!existsSync(DOC_PATH)) writeFileSync(DOC_PATH, '# 图片测试\n');
}

test.beforeAll(async () => {
  ensureDoc();
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

/** 打开带路径的文档，使图片 assets 目录落到文档同目录 */
test.beforeEach(async () => {
  ensureDoc();
  await electronApp.evaluate(
    ({ BrowserWindow }, { path, content }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('cmd', 'open-file-path', {
        path,
        content
      });
    },
    { path: DOC_PATH, content: readFileSync(DOC_PATH, 'utf-8') }
  );
  await window.waitForSelector('.ProseMirror h1', { timeout: 5000 });
});

test.describe('图片粘贴/拖拽', () => {
  test('拖拽图片文件：保存 assets、插入相对路径并可真实加载', async () => {
    // 合成带图片文件的 drop 事件（与真实拖拽同一入口 handleImageDrop/insertFiles）
    await window.locator('.ProseMirror').evaluate((el, base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'drop.png', { type: 'image/png' }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    }, PNG_BASE64);

    // 等插入的图片元素出现（保存+插入是异步链路）；
    // 编辑器 DOM src 是 typewren-img:// 协议（解析后的可加载 URL），
    // 而文档内容里的 Markdown 仍是相对路径（见下个用例的打开加载验证）
    const img = window.locator('.ProseMirror img[src^="typewren-img://local/"]');
    await expect(img).toHaveCount(1, { timeout: 10000 });

    const src = await img.getAttribute('src');
    expect(src).toMatch(/^typewren-img:\/\/local\/.+$/);
    // 协议 URL 解码后应指向文档同目录 assets/（主进程保存位置）
    const decoded = decodeURIComponent(src!.slice('typewren-img://local/'.length));
    expect(decoded.startsWith(WORK_DIR.replace(/\\/g, '/') + '/assets/')).toBe(true);

    // 磁盘上存在该文件且为合法 PNG，与协议 URL 指向同一路径
    const savedPath = join(WORK_DIR, 'assets', decoded.split('/').pop()!);
    const buf = readFileSync(savedPath);
    expect(buf.slice(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

    // 真实加载断言：主进程协议处理器读盘返回（此前相对 src 在页面基址下 404）
    await expect
      .poll(() => img.evaluate((el) => (el as HTMLImageElement).complete && el.naturalWidth > 0), {
        timeout: 10000
      })
      .toBe(true);
  });

  test('打开含相对图片引用的文档：按文档目录解析并加载', async () => {
    // 预置文档与同目录 assets 图片，文档内是 ./assets/xx.png 相对引用
    const assetDir = join(WORK_DIR, 'assets');
    mkdirSync(assetDir, { recursive: true });
    const imgName = 'existing.png';
    writeFileSync(join(assetDir, imgName), Buffer.from(PNG_BASE64, 'base64'));
    const relDoc = join(WORK_DIR, 'rel-test.md');
    const content = `![x](./assets/${imgName})\n`;
    writeFileSync(relDoc, content);

    await electronApp.evaluate(
      ({ BrowserWindow }, { path, content: c }) => {
        BrowserWindow.getAllWindows()[0].webContents.send('cmd', 'open-file-path', {
          path,
          content: c
        });
      },
      { path: relDoc, content }
    );

    const img = window.locator('.ProseMirror img[src^="typewren-img://local/"]');
    await expect(img).toHaveCount(1, { timeout: 5000 });
    const decoded = decodeURIComponent(
      (await img.getAttribute('src'))!.slice('typewren-img://local/'.length)
    );
    expect(decoded).toBe(join(assetDir, imgName).replace(/\\/g, '/'));
    await expect
      .poll(() => img.evaluate((el) => (el as HTMLImageElement).complete && el.naturalWidth > 0), {
        timeout: 10000
      })
      .toBe(true);
  });

  test('本地文件复制：saveImageFromPath 落盘 assets', async () => {
    const srcPng = join(WORK_DIR, 'src-image.png');
    if (!existsSync(srcPng)) {
      writeFileSync(srcPng, Buffer.from(PNG_BASE64, 'base64'));
    }

    const result = await window.evaluate(
      async ({ srcPath, docPath }) => {
        return window.typewren.saveImageFromPath({ srcPath, docPath });
      },
      { srcPath: srcPng, docPath: join(WORK_DIR, 'doc.md') }
    );

    expect(result.ok).toBe(true);
    const savedPath = (result as { savedPath: string }).savedPath;
    expect(savedPath).toMatch(/image-\d{8}-\d{6}-\d{4}\.png$/);
    expect(existsSync(savedPath)).toBe(true);
    expect(readFileSync(savedPath).slice(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  test('不支持的源扩展名被拒绝', async () => {
    const exePath = join(WORK_DIR, 'evil.txt');
    writeFileSync(exePath, 'not an image');
    const result = await window.evaluate(
      async ({ srcPath, docPath }) => {
        return window.typewren.saveImageFromPath({ srcPath, docPath });
      },
      { srcPath: exePath, docPath: join(WORK_DIR, 'doc.md') }
    );
    expect(result.ok).toBe(false);
  });
});
