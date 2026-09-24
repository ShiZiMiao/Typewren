import { test, expect } from '@playwright/test';
import { formatReleaseNotes, htmlNotesToPlainText } from '../src/main/updater';

/* ============================================================
 * L1 纯函数单测：「发现新版本」弹框的发布说明规整
 * 来源形态：GitHub releases.atom 的 content 是 markdown 渲染后的 HTML，
 * 直接塞原生弹框会裸露标签（0.7.1 发版实测截图）。
 * ============================================================ */

test.describe('htmlNotesToPlainText（发布说明 HTML → 纯文本）', () => {
  test('块级标签分行、li 转项目符号、行内标签去标记留内容', () => {
    const html =
      '<h2>[0.7.2] - 2026-09-22</h2>' +
      '<p>修复批次。</p>' +
      '<h3>修复</h3>' +
      '<ul><li><strong>数据安全</strong>：丢字问题</li>' +
      '<li><code>file:write</code> 限定扩展名</li></ul>';
    const text = htmlNotesToPlainText(html);
    expect(text).toContain('[0.7.2] - 2026-09-22');
    expect(text).toContain('修复批次。');
    expect(text).toContain('• 数据安全：丢字问题');
    expect(text).toContain('• file:write 限定扩展名');
    expect(text).not.toMatch(/<[^>]+>/);
  });

  test('实体解码在去标签之后：代码示例的 &lt;div&gt; 还原为字面量', () => {
    const text = htmlNotesToPlainText('<li><code>&lt;div&gt;</code> 与 &amp;amp; 示例</li>');
    expect(text).toContain('• <div> 与 &amp; 示例');
  });

  test('<br> 换行、连续空行折叠、纯文本原样通过', () => {
    expect(htmlNotesToPlainText('a<br />b')).toBe('a\nb');
    expect(htmlNotesToPlainText('<p>a</p>\n\n\n\n<p>b</p>')).toBe('a\n\nb');
    expect(htmlNotesToPlainText('已经是纯文本\n第二行')).toBe('已经是纯文本\n第二行');
  });

  test('数字实体与不间断空格', () => {
    // 用码点断言：期望串里肉眼不可见的空白字符（NBSP/空格）用 toBe 会误报
    // &nbsp; 归一成普通空格（弹框文本里 NBPS 徒增不可见差异）
    expect(
      [...htmlNotesToPlainText('&#20013;&#x6587;&nbsp;x')].map((c) => c.codePointAt(0))
    ).toEqual([20013, 25991, 32, 120]);
    // 超界码点不炸（fromCodePoint 抛错 → 空串兜底）
    expect(htmlNotesToPlainText('&#999999999;ok')).toBe('ok');
  });
});

test.describe('formatReleaseNotes（归一 + 截断）', () => {
  test('数组形态（多版本 ReleaseNoteInfo[]）按序拼接', () => {
    const notes = [
      { version: '0.7.2', note: '<h2>0.7.2</h2><ul><li>A</li></ul>' },
      { version: '0.7.1', note: '<h2>0.7.1</h2><ul><li>B</li></ul>' }
    ];
    const text = formatReleaseNotes(notes);
    expect(text.indexOf('• A')).toBeGreaterThan(-1);
    expect(text.indexOf('• B')).toBeGreaterThan(text.indexOf('• A'));
  });

  test('超长截断到 24 行并提示见发布页', () => {
    const long = Array.from({ length: 40 }, (_, i) => `<p>第 ${i} 行</p>`).join('');
    const text = formatReleaseNotes(long);
    expect(text.split('\n').length).toBeLessThanOrEqual(26);
    expect(text.endsWith('……（完整更新日志见发布页）')).toBe(true);
  });

  test('空输入返回空串（弹框据此不显示说明段）', () => {
    expect(formatReleaseNotes(null)).toBe('');
    expect(formatReleaseNotes(undefined)).toBe('');
    expect(formatReleaseNotes('')).toBe('');
    expect(formatReleaseNotes([{ version: '1.0.0', note: '' }])).toBe('');
    expect(formatReleaseNotes('<p>  </p>')).toBe('');
  });
});
