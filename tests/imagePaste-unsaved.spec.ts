import { test, expect } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeApp, launchApp, type AppHandle } from './helpers';
import { PNG_BASE64 } from './fixtures/png';

/* ============================================================
 * 未保存文档的图片粘贴回归（用户报告的场景）：
 * 未保存（docPath=null）时图片落盘 userData/images，Markdown 引用
 * 是正斜杠绝对路径——必须经 typewren-img 协议解析并真实加载，
 * 不得再出现 C:%5C… 这种反斜杠被 encodeURI 污染的历史引用。
 * user-data-dir 故意带空格+括号：绝对路径引用会把编码端
 * （encodeMarkdownPath 补 ( ) # ?）与解码端（decodeImageRef）一起压到，
 * 路径特殊字符下"粘贴后图片不显示"的老坑家族都在这条链上。
 * ============================================================ */

let app: AppHandle;

const USER_DATA_DIR = join(tmpdir(), 'typewren img (unsaved)');

test.beforeAll(async () => {
  app = await launchApp([`--user-data-dir=${USER_DATA_DIR}`]);
});

test.afterAll(async () => {
  await closeApp(app);
});

test('未保存文档粘贴截图：落盘 userData/images 并真实加载', async () => {
  // 合成剪贴板位图 paste（与真实粘贴同一入口 handleImagePaste → insertFromData）
  await app.window.locator('.ProseMirror').evaluate((el, base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'paste.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, PNG_BASE64);

  const img = app.window.locator('.ProseMirror img[src^="typewren-img://local/"]');
  await expect(img).toHaveCount(1, { timeout: 10000 });

  // 解码后的绝对路径位于 userData/images（正斜杠，不再是 %5C）
  const src = (await img.getAttribute('src')) ?? '';
  const decoded = decodeURIComponent(src.slice('typewren-img://local/'.length));
  expect(decoded).toMatch(/^[A-Za-z]:\/.*\/images\/image-\d{8}-\d{6}-\d{4}\.png$/);
  expect(decoded.startsWith(USER_DATA_DIR.replace(/\\/g, '/') + '/images/')).toBe(true);
  expect(decoded).not.toContain('%5C');

  // 真实加载断言：此前 C:%5C… 被当成未知协议、naturalWidth 恒为 0
  await expect
    .poll(
      () =>
        img.evaluate((el) => {
          const image = el as HTMLImageElement;
          return image.complete && image.naturalWidth > 0;
        }),
      { timeout: 10000 }
    )
    .toBe(true);
});
