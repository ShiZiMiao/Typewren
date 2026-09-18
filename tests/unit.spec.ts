import { test, expect } from '@playwright/test';
import {
  isMarkdownPath,
  isImagePath,
  isImageFile,
  isFileContentPayload,
  isSaveAsPayload,
  isExportDocumentPayload,
  isImageSaveFromPathPayload,
  isImageSaveFromDataPayload,
  isImageDownloadPayload,
  MARKDOWN_EXTENSIONS
} from '../src/shared/ipc';
import { isSafeLinkHref } from '../src/renderer/src/util/link';
import { planStartupWindows } from '../src/main/startup';
import { normalizePopupPosition } from '../src/main/menu';
import { TITLEBAR_PALETTE } from '../src/shared/titlebar';
import { fromLocalImageUrl, resolveImageSrc, toLocalImageUrl } from '../src/shared/imageUrl';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS_SOURCE = readFileSync(
  join(__dirname, '../src/renderer/src/styles/variables.css'),
  'utf-8'
);

/** 从 variables.css 取某主题下的变量值（防止与 TITLEBAR_PALETTE 漂移） */
function cssVar(theme: 'light' | 'dark', name: string): string {
  const [lightPart, darkPart] = CSS_SOURCE.split(":root[data-theme='dark']");
  const section = theme === 'dark' ? (darkPart ?? CSS_SOURCE) : (lightPart ?? CSS_SOURCE);
  const match = section.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`CSS 变量 ${name}(${theme}) 未找到`);
  return match[1].trim();
}

/* ============================================================
 * L1 纯函数单测：直接 import 源码（Playwright 自带 TS 转译）
 * ============================================================ */

test.describe('shared/ipc 纯函数', () => {
  test('MARKDOWN_EXTENSIONS 常量', () => {
    expect(MARKDOWN_EXTENSIONS).toContain('.md');
    expect(MARKDOWN_EXTENSIONS).toContain('.markdown');
    expect(MARKDOWN_EXTENSIONS).toContain('.mdown');
  });

  test('isMarkdownPath 判断', () => {
    expect(isMarkdownPath('a.md')).toBe(true);
    expect(isMarkdownPath('a.markdown')).toBe(true);
    expect(isMarkdownPath('a.mdown')).toBe(true);
    expect(isMarkdownPath('A.MD')).toBe(true);
    expect(isMarkdownPath('dir/sub/a.MARKDOWN')).toBe(true);
    expect(isMarkdownPath('a.txt')).toBe(false);
    expect(isMarkdownPath('archive.tar.md')).toBe(true);
    expect(isMarkdownPath('README')).toBe(false);
    expect(isMarkdownPath('noext.')).toBe(false);
  });

  test('isImagePath 判断', () => {
    expect(isImagePath('pic.png')).toBe(true);
    expect(isImagePath('pic.jpg')).toBe(true);
    expect(isImagePath('pic.jpeg')).toBe(true);
    expect(isImagePath('pic.gif')).toBe(true);
    expect(isImagePath('pic.webp')).toBe(true);
    expect(isImagePath('pic.svg')).toBe(true);
    expect(isImagePath('pic.tiff')).toBe(true);
    expect(isImagePath('PIC.PNG')).toBe(true);
    expect(isImagePath('pic.exe')).toBe(false);
    expect(isImagePath('pic')).toBe(false);
  });

  test('isImageFile 判断（type 优先，扩展名兜底）', () => {
    expect(isImageFile({ type: 'image/png', name: 'a.bin' })).toBe(true);
    expect(isImageFile({ type: '', name: 'a.png' })).toBe(true);
    expect(isImageFile({ type: 'text/plain', name: 'a.png' })).toBe(true);
    expect(isImageFile({ type: 'application/octet-stream', name: 'evil.exe' })).toBe(false);
    expect(isImageFile({ type: '', name: 'evi.txt' })).toBe(false);
  });

  test('isFileContentPayload 类型守卫', () => {
    expect(isFileContentPayload({ path: '/x.md', content: 'abc' })).toBe(true);
    expect(isFileContentPayload({ path: '', content: '' })).toBe(true);
    expect(isFileContentPayload({ path: '/x.md' })).toBe(false);
    expect(isFileContentPayload({ path: 3, content: 'abc' })).toBe(false);
    expect(isFileContentPayload(null)).toBe(false);
    expect(isFileContentPayload('str')).toBe(false);
    expect(isFileContentPayload(undefined)).toBe(false);
  });

  test('isSaveAsPayload 类型守卫', () => {
    expect(isSaveAsPayload({ content: 'abc' })).toBe(true);
    expect(isSaveAsPayload({ content: 'abc', suggestedName: 'a.md' })).toBe(true);
    expect(isSaveAsPayload({ content: '' })).toBe(true);
    expect(isSaveAsPayload({ suggestedName: 'a.md' })).toBe(false);
    expect(isSaveAsPayload({ content: 3 })).toBe(false);
    expect(isSaveAsPayload({ content: 'abc', suggestedName: 3 })).toBe(false);
    expect(isSaveAsPayload(null)).toBe(false);
    expect(isSaveAsPayload('str')).toBe(false);
  });

  test('isExportDocumentPayload 类型守卫', () => {
    expect(isExportDocumentPayload({ kind: 'pdf', html: '<html>', suggestedName: 'a.pdf' })).toBe(
      true
    );
    expect(isExportDocumentPayload({ kind: 'html', html: '<html>', suggestedName: 'a.html' })).toBe(
      true
    );
    expect(isExportDocumentPayload({ kind: 'exe', html: '<html>', suggestedName: 'a.pdf' })).toBe(
      false
    );
    expect(isExportDocumentPayload({ kind: 'pdf', html: 3, suggestedName: 'a.pdf' })).toBe(false);
    expect(isExportDocumentPayload({ kind: 'pdf', html: '<html>' })).toBe(false);
    expect(isExportDocumentPayload(null)).toBe(false);
  });

  test('图片载荷类型守卫（docPath 只允许 string|null）', () => {
    expect(isImageSaveFromPathPayload({ srcPath: 'a.png', docPath: 'C:/x/doc.md' })).toBe(true);
    expect(isImageSaveFromPathPayload({ srcPath: 'a.png', docPath: null })).toBe(true);
    expect(isImageSaveFromPathPayload({ srcPath: 'a.png' })).toBe(false);
    expect(isImageSaveFromPathPayload({ srcPath: 'a.png', docPath: 3 })).toBe(false);
    expect(isImageSaveFromPathPayload(null)).toBe(false);

    expect(isImageSaveFromDataPayload({ base64: 'a', mime: 'image/png', docPath: null })).toBe(
      true
    );
    expect(
      isImageSaveFromDataPayload({ base64: 'a', mime: 'image/png', docPath: 'C:/x/doc.md' })
    ).toBe(true);
    expect(isImageSaveFromDataPayload({ base64: 'a', mime: 'image/png' })).toBe(false);
    expect(isImageSaveFromDataPayload({ base64: 'a', mime: 3, docPath: null })).toBe(false);

    expect(isImageDownloadPayload({ url: 'https://x/a.png', docPath: null })).toBe(true);
    expect(isImageDownloadPayload({ url: 'https://x/a.png', docPath: 'C:/x/doc.md' })).toBe(true);
    expect(isImageDownloadPayload({ url: 'https://x/a.png' })).toBe(false);
    expect(isImageDownloadPayload({ url: 3, docPath: null })).toBe(false);
  });

  test('isSafeLinkHref 协议白名单', () => {
    expect(isSafeLinkHref('https://example.com')).toBe(true);
    expect(isSafeLinkHref('http://example.com')).toBe(true);
    expect(isSafeLinkHref('mailto:a@b.com')).toBe(true);
    expect(isSafeLinkHref('./page.md')).toBe(true);
    expect(isSafeLinkHref('#anchor')).toBe(true);
    expect(isSafeLinkHref('docs/guide.html')).toBe(true);
    expect(isSafeLinkHref('javascript:alert(1)')).toBe(false);
    expect(isSafeLinkHref('data:text/html;base64,xxx')).toBe(false);
    expect(isSafeLinkHref('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeLinkHref('file:///C:/x.html')).toBe(false);
    expect(isSafeLinkHref('')).toBe(false);
  });
});

test.describe('标题栏配色常量与 CSS 变量同步', () => {
  test('亮色调色板与 --bg-soft / --text-muted 一致', () => {
    expect(TITLEBAR_PALETTE.light.color).toBe(cssVar('light', '--bg-soft'));
    expect(TITLEBAR_PALETTE.light.symbolColor).toBe(cssVar('light', '--text-muted'));
  });

  test('暗色调色板与 --bg-soft / --text-muted 一致', () => {
    expect(TITLEBAR_PALETTE.dark.color).toBe(cssVar('dark', '--bg-soft'));
    expect(TITLEBAR_PALETTE.dark.symbolColor).toBe(cssVar('dark', '--text-muted'));
  });
});

/* ---------- 启动窗口规划（main/startup.ts 纯函数） ---------- */
const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

test.describe('normalizePopupPosition（menu:popup 坐标归一化）', () => {
  test('小数坐标取整（页面缩放后 getBoundingClientRect 的 7.5px）', () => {
    expect(normalizePopupPosition(7.5, 44.2)).toEqual({ x: 8, y: 44 });
  });
  test('非有限数 / 非 number 拒绝', () => {
    expect(normalizePopupPosition(NaN, 10)).toBeNull();
    expect(normalizePopupPosition(Infinity, 10)).toBeNull();
    expect(normalizePopupPosition('7', 10)).toBeNull();
    expect(normalizePopupPosition(undefined, 10)).toBeNull();
  });
});

test.describe('planStartupWindows', () => {
  test('命令行文件优先，忽略会话与草稿', () => {
    const plan = planStartupWindows(
      '/docs/a.md',
      [{ path: '/docs/d.md', content: 'x', savedAt: 1 }],
      ['/docs/s.md']
    );
    expect(plan).toHaveLength(1);
    expect(norm(plan[0].path)).toContain('a.md');
    expect(plan[0].content).toBeUndefined();
  });

  test('草稿在前（带内容与 restore 标记），会话补后且去重', () => {
    const plan = planStartupWindows(
      null,
      [{ path: '/docs/shared.md', content: 'draft', savedAt: 1 }],
      ['/docs/shared.md', '/docs/only-session.md']
    );
    expect(plan).toHaveLength(2);
    expect(norm(plan[0].path)).toContain('shared.md');
    expect(plan[0].content).toBe('draft');
    expect(plan[0].restore).toBe(true);
    expect(norm(plan[1].path)).toContain('only-session.md');
    expect(plan[1].content).toBeUndefined();
  });

  test('空输入 → 空计划（正常开空白窗口）', () => {
    expect(planStartupWindows(null, [], [])).toHaveLength(0);
  });
});

test.describe('shared/imageUrl 图片协议 URL', () => {
  test('toLocalImageUrl / fromLocalImageUrl 往返（含中文与空格）', () => {
    const path = String.raw`D:\文档 目录\图片 01.png`;
    const url = toLocalImageUrl(path);
    expect(url.startsWith('typewren-img://local/')).toBe(true);
    expect(fromLocalImageUrl(url)).toBe('D:/文档 目录/图片 01.png');
  });

  test('非本协议 URL 解析返回 null（大小写耐药）', () => {
    expect(fromLocalImageUrl('https://x/y.png')).toBeNull();
    expect(fromLocalImageUrl('typewren-img://local/')).toBeNull();
    expect(fromLocalImageUrl('TYPEWREN-IMG://local/abc')).toBe('abc');
  });

  test('resolveImageSrc：相对引用按文档目录解析', () => {
    expect(resolveImageSrc('./assets/a.png', 'D:/docs')).toBe(
      'typewren-img://local/' + encodeURIComponent('D:/docs/assets/a.png')
    );
    expect(resolveImageSrc('../pics/b.png', 'D:/docs/blog')).toBe(
      'typewren-img://local/' + encodeURIComponent('D:/docs/pics/b.png')
    );
    // 无文档目录时无法解析，原样返回（浏览器按页面基址解析，自会 404）
    expect(resolveImageSrc('./assets/a.png', null)).toBe('./assets/a.png');
  });

  test('resolveImageSrc：绝对路径与既有协议透传/转换', () => {
    expect(resolveImageSrc('C:/pics/a.png', null)).toBe(
      'typewren-img://local/' + encodeURIComponent('C:/pics/a.png')
    );
    expect(resolveImageSrc('http://x/y.png', 'D:/docs')).toBe('http://x/y.png');
    expect(resolveImageSrc('data:image/png;base64,AA', 'D:/docs')).toBe(
      'data:image/png;base64,AA'
    );
    expect(resolveImageSrc('file:///D:/a.png', 'D:/docs')).toBe('file:///D:/a.png');
    // 已解析 URL 不再二次解析
    const once = toLocalImageUrl('D:/a.png');
    expect(resolveImageSrc(once, 'D:/docs')).toBe(once);
  });

  test('resolveImageSrc：兼容 encodeURI 时代反斜杠被编码成 %5C 的历史引用', () => {
    const legacy = 'C:%5CUsers%5Clecoo%5Cx.png';
    expect(resolveImageSrc(legacy, null)).toBe(
      'typewren-img://local/' + encodeURIComponent('C:/Users/lecoo/x.png')
    );
    // 相对引用里的 %5C（历史手写）同样先转正再拼文档目录
    expect(resolveImageSrc('./img%5Ca.png', 'D:/docs')).toBe(
      'typewren-img://local/' + encodeURIComponent('D:/docs/img/a.png')
    );
  });
});
