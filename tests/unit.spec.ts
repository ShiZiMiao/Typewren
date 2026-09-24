import { test, expect } from '@playwright/test';
import {
  isMarkdownPath,
  isOpenablePath,
  isImagePath,
  isImageFile,
  isFileContentPayload,
  isSaveAsPayload,
  isExportDocumentPayload,
  isConfirmDialogPayload,
  isImageSaveFromPathPayload,
  isImageSaveFromDataPayload,
  isImageDownloadPayload,
  MARKDOWN_EXTENSIONS,
  OPENABLE_EXTENSIONS
} from '../src/shared/ipc';
import { isSafeLinkHref } from '../src/renderer/src/util/link';
import { accumulateWheelDelta } from '../src/renderer/src/ui/zoom';
import {
  resolveZoomAction,
  clampZoomPercent,
  ZOOM_PERCENT_DEFAULT,
  ZOOM_PERCENT_MAX,
  ZOOM_PERCENT_MIN,
  ZOOM_PERCENT_STEP
} from '../src/shared/zoomKeys';
import { planStartupWindows } from '../src/main/startup';
import { normalizePopupPosition } from '../src/main/menu';
import { isTestMode, suppressesUi } from '../src/main/runMode';
import { extFromUrlPath, isBlockedFetchHost } from '../src/main/images';
import { TITLEBAR_PALETTE } from '../src/shared/titlebar';
import {
  fromLocalImageUrl,
  joinPath,
  resolveImageSrc,
  toLocalImageUrl
} from '../src/shared/imageUrl';
import { absolutePathOrEmpty } from '../src/shared/pathKey';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/shared/settings';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CSS_SOURCE = readFileSync(
  join(__dirname, '../src/renderer/src/styles/variables.css'),
  'utf-8'
);
const BUILDER_YML = readFileSync(join(__dirname, '../electron-builder.yml'), 'utf-8');

/**
 * 从 variables.css 取某主题下的变量值（防止与 TITLEBAR_PALETTE 漂移）。
 * 先去注释再按"选择器块"提取（花括号配对 + 选择器形态判定）：旧实现
 * split(":root[data-theme='dark']") 对选择器写法（空格/引号/属性顺序）零容错，
 * 样式文件一改写就全体假失败；块前的注释也会污染选择器文本，必须先剥掉。
 */
function cssVar(theme: 'light' | 'dark', name: string): string {
  const source = CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');
  const blockRe = /([^{}]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(source)) !== null) {
    const selector = m[1].trim();
    const isDarkBlock = /data-theme\s*=\s*['"]dark['"]/.test(selector);
    if (theme === 'dark' ? !isDarkBlock : !(selector === ':root')) continue;
    const start = blockRe.lastIndex;
    const end = source.indexOf('}', start);
    const body = source.slice(start, end === -1 ? undefined : end);
    const hit = body.match(new RegExp(`${name}:\\s*([^;]+);`));
    if (hit) return hit[1].trim();
  }
  throw new Error(`CSS 变量 ${name}(${theme}) 未找到`);
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

  test('isImagePath 判断（路径/文件名皆可，参数名 filePath 语义）', () => {
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
    // 完整路径形态（落盘/协议侧传的是绝对路径）
    expect(isImagePath('D:/assets/pic.png')).toBe(true);
    expect(isImagePath('/home/u/assets/pic.GIF')).toBe(true);
    expect(isImagePath('D:/assets/pic.exe')).toBe(false);
  });

  test('isOpenablePath 判断（可打开文档 = Markdown + txt）', () => {
    expect(isOpenablePath('a.md')).toBe(true);
    expect(isOpenablePath('a.markdown')).toBe(true);
    expect(isOpenablePath('a.mdown')).toBe(true);
    expect(isOpenablePath('a.txt')).toBe(true);
    expect(isOpenablePath('A.TXT')).toBe(true);
    expect(isOpenablePath('D:/docs/a.md')).toBe(true);
    // 与 isMarkdownPath 的口径差异是刻意的（file:write / read / win:set-path 统一走它）
    expect(isOpenablePath('a.png')).toBe(false);
    expect(isOpenablePath('a.exe')).toBe(false);
    expect(isOpenablePath('README')).toBe(false);
    expect(isOpenablePath('')).toBe(false);
  });

  test('isConfirmDialogPayload：按钮数与 cancelId 边界', () => {
    expect(isConfirmDialogPayload({ message: 'm', buttons: ['a', 'b'] })).toBe(true);
    expect(isConfirmDialogPayload({ message: 'm', buttons: ['a'], cancelId: 0 })).toBe(true);
    expect(
      isConfirmDialogPayload({ message: 'm', detail: 'd', buttons: ['1', '2', '3', '4'], cancelId: 3 })
    ).toBe(true);
    // 原生确认框按钮数上限 4
    expect(isConfirmDialogPayload({ message: 'm', buttons: ['1', '2', '3', '4', '5'] })).toBe(false);
    expect(isConfirmDialogPayload({ message: 'm', buttons: [] })).toBe(false);
    expect(isConfirmDialogPayload({ message: 'm', buttons: [1] })).toBe(false);
    // cancelId 必须落在按钮下标范围内（越界会让 showMessageBox 抛错/静默错位）
    expect(isConfirmDialogPayload({ message: 'm', buttons: ['a', 'b'], cancelId: 2 })).toBe(false);
    expect(isConfirmDialogPayload({ message: 'm', buttons: ['a', 'b'], cancelId: -1 })).toBe(false);
    expect(isConfirmDialogPayload({ message: 'm', buttons: ['a', 'b'], cancelId: 1.5 })).toBe(false);
    expect(isConfirmDialogPayload({ message: 'm', buttons: ['a', 'b'], cancelId: 'x' })).toBe(false);
    expect(isConfirmDialogPayload({ message: 'm', buttons: ['a', 'b'], detail: 1 })).toBe(false);
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
  test('zoom=1 恒等 + 小数坐标取整（页面缩放后 getBoundingClientRect 的 7.5px）', () => {
    expect(normalizePopupPosition(7.5, 44.2, 1)).toEqual({ x: 8, y: 44 });
  });
  test('缩放换算：视口 CSS 坐标 × zoomFactor → 窗口 DIP（错位回归）', () => {
    // 放大（factor 2）：css 7.5 → dip 15；缩小时 css 值偏大、乘 0.5 还原
    expect(normalizePopupPosition(7.5, 44.2, 2)).toEqual({ x: 15, y: 88 });
    expect(normalizePopupPosition(100, 40, 0.5)).toEqual({ x: 50, y: 20 });
    // 真实步进档 zoomLevel 0.5 → factor 1.2^0.5 ≈ 1.0954
    expect(normalizePopupPosition(7.5, 40, 1.2 ** 0.5)).toEqual({ x: 8, y: 44 });
  });
  test('非法 zoomFactor 拒绝（0 / 负 / NaN / 非 number）', () => {
    expect(normalizePopupPosition(10, 10, 0)).toBeNull();
    expect(normalizePopupPosition(10, 10, -1)).toBeNull();
    expect(normalizePopupPosition(10, 10, NaN)).toBeNull();
    expect(normalizePopupPosition(10, 10, '1')).toBeNull();
  });
  test('非有限数 / 非 number 拒绝', () => {
    expect(normalizePopupPosition(NaN, 10, 1)).toBeNull();
    expect(normalizePopupPosition(Infinity, 10, 1)).toBeNull();
    expect(normalizePopupPosition('7', 10, 1)).toBeNull();
    expect(normalizePopupPosition(undefined, 10, 1)).toBeNull();
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
    // 命令行文件是用户主动打开：领取成功后要记入最近文件
    expect(plan[0].recent).toBe(true);
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

  test('多个未命名草稿各自独立成窗（pathKey("")≈cwd，不得互相去重吞内容）', () => {
    const plan = planStartupWindows(
      null,
      [
        { path: '', content: '甲', savedAt: 1 },
        { path: '', content: '乙', savedAt: 2 }
      ],
      []
    );
    expect(plan).toHaveLength(2);
    expect(plan[0].content).toBe('甲');
    expect(plan[1].content).toBe('乙');
    expect(plan[0].restore).toBe(true);
    expect(plan[1].restore).toBe(true);
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
    expect(resolveImageSrc('data:image/png;base64,AA', 'D:/docs')).toBe('data:image/png;base64,AA');
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

test.describe('shared/settings 校验', () => {
  test('非法输入回落默认值', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('')).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  test('合法字段保留，未知字段丢弃', () => {
    const s = sanitizeSettings({
      fontSize: 18,
      theme: 'dark',
      autoSave: true,
      hackerField: 'x'
    } as unknown);
    expect(s.fontSize).toBe(18);
    expect(s.theme).toBe('dark');
    expect(s.autoSave).toBe(true);
    expect('hackerField' in s).toBe(false);
  });

  test('数值越界钳制、类型错误回落', () => {
    const s = sanitizeSettings({
      fontSize: 999,
      lineHeight: 0,
      editorWidth: 10,
      autoSaveInterval: 'abc',
      draftInterval: -5
    } as unknown);
    expect(s.fontSize).toBe(32);
    expect(s.lineHeight).toBe(1);
    expect(s.editorWidth).toBe(320);
    expect(s.autoSaveInterval).toBe(DEFAULT_SETTINGS.autoSaveInterval);
    expect(s.draftInterval).toBe(5);
  });

  test('非法主题/布尔值回落', () => {
    const s = sanitizeSettings({ theme: 'blue', spellcheck: 'yes', autoPairs: 1 } as unknown);
    expect(s.theme).toBe('system');
    expect(s.spellcheck).toBe(false);
    expect(s.autoPairs).toBe(true);
  });
});

test.describe('ui/zoom 缩放快捷键映射', () => {
  type ZoomKey = Parameters<typeof resolveZoomAction>[0];
  const key = (over: Partial<ZoomKey>): ZoomKey => ({
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    code: '',
    key: '',
    ...over
  });

  test('放大：Ctrl+= / Ctrl++（Shift+=）/ 小键盘+', () => {
    expect(resolveZoomAction(key({ code: 'Equal', key: '=' }))).toBe('in');
    expect(resolveZoomAction(key({ code: 'Equal', key: '+', shiftKey: true }))).toBe('in');
    expect(resolveZoomAction(key({ code: 'NumpadAdd', key: '+' }))).toBe('in');
    // code 缺失时的 key 兜底（异常布局/合成事件）
    expect(resolveZoomAction(key({ key: '+' }))).toBe('in');
    expect(resolveZoomAction(key({ key: '=' }))).toBe('in');
  });

  test('缩小：Ctrl+- / Ctrl+_ / 小键盘-', () => {
    expect(resolveZoomAction(key({ code: 'Minus', key: '-' }))).toBe('out');
    expect(resolveZoomAction(key({ code: 'Minus', key: '_', shiftKey: true }))).toBe('out');
    expect(resolveZoomAction(key({ code: 'NumpadSubtract', key: '-' }))).toBe('out');
    expect(resolveZoomAction(key({ key: '-' }))).toBe('out');
  });

  test('重置：主推 Ctrl+Shift+D（D=Default）', () => {
    expect(resolveZoomAction(key({ code: 'KeyD', key: 'D', shiftKey: true }))).toBe('reset');
    // 无 Shift 的 Ctrl+D 不是缩放
    expect(resolveZoomAction(key({ code: 'KeyD', key: 'd' }))).toBeNull();
  });

  test('重置备用判定（Ctrl+Shift+0 系）与裸 Ctrl+0 对照', () => {
    // 菜单不显示的备用键位：系统/输入法未占用时同样生效
    expect(resolveZoomAction(key({ code: 'Digit0', key: ')', shiftKey: true }))).toBe('reset');
    // 小键盘 0 + Shift
    expect(resolveZoomAction(key({ code: 'Numpad0', key: '0', shiftKey: true }))).toBe('reset');
    // 无 code 的合成事件：key='0' + shift 兜底
    expect(resolveZoomAction(key({ key: '0', shiftKey: true }))).toBe('reset');
    // 布局/输入法把 Shift 语义折进 key（直接产出 ')'），shift 标志缺失也认
    expect(resolveZoomAction(key({ key: ')' }))).toBe('reset');
    // 裸 Ctrl+0 的各种产出都仍是 null（归段落→正文，不能被放宽误伤）
    expect(resolveZoomAction(key({ code: 'Digit0', key: '0' }))).toBeNull();
    expect(resolveZoomAction(key({ key: '0' }))).toBeNull();
    expect(resolveZoomAction(key({ code: 'Numpad0', key: '0' }))).toBeNull();
  });

  test('修饰键守卫：无 Ctrl / 带 Alt / 输入法组合不响应', () => {
    expect(resolveZoomAction(key({ code: 'Equal', key: '=', ctrlKey: false }))).toBeNull();
    // mac 风格 Cmd 保留支持
    expect(resolveZoomAction(key({ code: 'Equal', key: '=', ctrlKey: false, metaKey: true }))).toBe(
      'in'
    );
    expect(resolveZoomAction(key({ code: 'Equal', key: '=', altKey: true }))).toBeNull();
    expect(resolveZoomAction(key({ code: 'Equal', key: '=', isComposing: true }))).toBeNull();
  });

  test('缩放百分比上下限钳制（clampZoomPercent）', () => {
    // 内容区缩放语义：50%–300%，步进 10 个百分点
    expect(ZOOM_PERCENT_MAX).toBe(300);
    expect(ZOOM_PERCENT_MIN).toBe(50);
    expect(ZOOM_PERCENT_STEP).toBe(10);
    expect(ZOOM_PERCENT_DEFAULT).toBe(100);
    // 区间内取整返回
    expect(clampZoomPercent(100)).toBe(100);
    expect(clampZoomPercent(110)).toBe(110);
    expect(clampZoomPercent(114.4)).toBe(114);
    // 越界钳制（到顶/到底）
    expect(clampZoomPercent(310)).toBe(300);
    expect(clampZoomPercent(999)).toBe(300);
    expect(clampZoomPercent(40)).toBe(50);
    expect(clampZoomPercent(0)).toBe(50);
    // 边界值本身不动
    expect(clampZoomPercent(300)).toBe(300);
    expect(clampZoomPercent(50)).toBe(50);
  });

  test('滚轮累计器：一格直接步进，小增量累计到阈值才步进', () => {
    // 普通滚轮一格（±100px）→ 直接一步且清零
    expect(accumulateWheelDelta(0, -100)).toEqual({ acc: 0, action: 'in' });
    expect(accumulateWheelDelta(0, 100)).toEqual({ acc: 0, action: 'out' });
    // 高分辨率触控板小增量：累计不足阈值不步进
    expect(accumulateWheelDelta(0, -15)).toEqual({ acc: -15, action: null });
    expect(accumulateWheelDelta(-15, -15)).toEqual({ acc: -30, action: null });
    // 第三次越过阈值（45 ≥ 40）→ 步进并清零
    expect(accumulateWheelDelta(-30, -15)).toEqual({ acc: 0, action: 'in' });
    // 行模式（deltaMode=1）折算后同样步进
    expect(accumulateWheelDelta(0, -1, 1)).toEqual({ acc: 0, action: 'in' });
    // 方向相反的小增量代数累计（抵消到阈值内不步进；越过阈值按净值方向步进）
    expect(accumulateWheelDelta(20, -10)).toEqual({ acc: 10, action: null });
    expect(accumulateWheelDelta(20, -70)).toEqual({ acc: 0, action: 'in' });
  });
});

test.describe('runMode 测试模式谓词（原 7 处 argv.includes 收口）', () => {
  test('isTestMode：只认 --test（副作用关闭口径）', () => {
    expect(isTestMode(['node', 'app', '--test'])).toBe(true);
    expect(isTestMode(['node', 'app', '--headless'])).toBe(false);
    expect(isTestMode(['node', 'app'])).toBe(false);
    expect(isTestMode([])).toBe(false);
  });

  test('suppressesUi：--test / --headless 都抑制显示（与 isTestMode 口径有意不同）', () => {
    expect(suppressesUi(['node', 'app', '--test'])).toBe(true);
    expect(suppressesUi(['node', 'app', '--headless'])).toBe(true);
    expect(suppressesUi(['node', 'app', '--headless', '--test'])).toBe(true);
    expect(suppressesUi(['node', 'app'])).toBe(false);
    expect(suppressesUi([])).toBe(false);
  });
});

test.describe('shared/pathKey 路径归一化', () => {
  test('absolutePathOrEmpty：空路径保持空串（未命名语义，不得变成 cwd）', () => {
    // 坑：resolve('') === process.cwd()——被绑成文档路径后保存报 EISDIR、
    // 草稿永远清不掉（drafts.spec「未命名草稿恢复后可保存」有 e2e 回归）
    expect(absolutePathOrEmpty('')).toBe('');
    expect(absolutePathOrEmpty('a.md')).toBe(resolve('a.md'));
    expect(absolutePathOrEmpty(resolve('a.md'))).toBe(resolve('a.md'));
  });
});

test.describe('shared/imageUrl joinPath', () => {
  test('POSIX 根不得丢失（丢了根相对图片在 mac/Linux 全挂）', () => {
    // '/home/u/doc' 拆分首段是空串（根标记），拼合后必须加回前导 '/'
    expect(joinPath('/home/u/doc', './assets/a.png')).toBe('/home/u/doc/assets/a.png');
    expect(joinPath('/home/u/doc', '../pics/b.png')).toBe('/home/u/pics/b.png');
    expect(joinPath('/', 'a.png')).toBe('/a.png');
  });

  test('Windows 驱动器号路径不受根标记影响，.. 上跳不弹出驱动器', () => {
    expect(joinPath('D:/docs', './assets/a.png')).toBe('D:/docs/assets/a.png');
    // 语义与 resolveImageSrc 既有用例一致：blog/../pics → docs/pics
    expect(joinPath('D:/docs/blog', '../pics/b.png')).toBe('D:/docs/pics/b.png');
    expect(joinPath('D:/docs', '../../x.png')).toBe('D:/x.png');
  });
});

test.describe('main/images 扩展名兜底链与 SSRF 主机判定', () => {
  test('extFromUrlPath：无命中/非图片扩展名返回 null（空串会断掉 ?? 兜底链）', () => {
    expect(extFromUrlPath('/a/b.png')).toBe('.png');
    expect(extFromUrlPath('/a/b.PNG')).toBe('.png');
    expect(extFromUrlPath('/a/b.jpeg')).toBe('.jpeg');
    expect(extFromUrlPath('/no-ext')).toBeNull();
    expect(extFromUrlPath('/a/b')).toBeNull();
    expect(extFromUrlPath('/a/b.txt')).toBeNull();
    // 目录里的点不算扩展名，只看最后一段
    expect(extFromUrlPath('/a.tar.gz/x.png')).toBe('.png');
    expect(extFromUrlPath('')).toBeNull();
  });

  test('isBlockedFetchHost：环回/私有字面 IP 与本机名拒绝，公网放行', () => {
    expect(isBlockedFetchHost('127.0.0.1')).toBe(true);
    expect(isBlockedFetchHost('127.1.2.3')).toBe(true);
    expect(isBlockedFetchHost('10.1.2.3')).toBe(true);
    expect(isBlockedFetchHost('192.168.1.1')).toBe(true);
    expect(isBlockedFetchHost('172.16.0.1')).toBe(true);
    expect(isBlockedFetchHost('172.31.255.255')).toBe(true);
    expect(isBlockedFetchHost('169.254.1.1')).toBe(true);
    expect(isBlockedFetchHost('0.0.0.0')).toBe(true);
    expect(isBlockedFetchHost('localhost')).toBe(true);
    expect(isBlockedFetchHost('MyPC.local')).toBe(true);
    expect(isBlockedFetchHost('[::1]')).toBe(true);
    // 字面判定：域名解析不在本层；172.32 起 / 11.x / 192.169 均非私有段
    expect(isBlockedFetchHost('example.com')).toBe(false);
    expect(isBlockedFetchHost('8.8.8.8')).toBe(false);
    expect(isBlockedFetchHost('172.32.0.1')).toBe(false);
    expect(isBlockedFetchHost('192.169.1.1')).toBe(false);
    expect(isBlockedFetchHost('11.0.0.1')).toBe(false);
    expect(isBlockedFetchHost('193.0.0.1')).toBe(false);
  });
});

test.describe('打包文件关联与可打开扩展名同步', () => {
  test('electron-builder.yml 的 fileAssociations 与 MARKDOWN_EXTENSIONS 一致', () => {
    // 文件关联（资源管理器双击）与可打开口径必须同步扩缩：
    // 否则"系统关联了却打不开 / 能打开却没有关联"
    const section = BUILDER_YML.split(/^fileAssociations:/m)[1] ?? '';
    const body = section.split(/\n(?=\S)/)[0] ?? '';
    const exts = [...body.matchAll(/ext:\s*([^\s]+)/g)].map((m) => `.${m[1]}`);
    expect(new Set(exts)).toEqual(new Set(MARKDOWN_EXTENSIONS));
  });

  test('OPENABLE_EXTENSIONS = MARKDOWN_EXTENSIONS + .txt（file:write 等收口口径）', () => {
    expect(new Set(OPENABLE_EXTENSIONS)).toEqual(new Set([...MARKDOWN_EXTENSIONS, '.txt']));
  });
});
