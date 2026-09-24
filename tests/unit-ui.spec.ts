import { test, expect } from '@playwright/test';
import { isSafeLinkHref } from '../src/renderer/src/util/link';
import { escapeHtml } from '../src/renderer/src/util/escape';

/* ============================================================
 * 渲染层纯函数单测（util/link 白名单 / util/escape 转义）
 * 与 unit.spec.ts 同法：不起 Electron，直接 import 源模块跑纯函数。
 * ============================================================ */

test.describe('util/link：链接协议白名单', () => {
  test('控制字符绕过回归（HTML URL 解析会剥离 \\t\\n\\r\\f 后执行）', () => {
    // CommonMark 把 `java&#10;script:` 的实体解码成真实 \n 再进到这里——
    // 旧实现 scheme 正则在 \n 处断开、误判"无协议=安全"放行，
    // 导出 HTML 点击即 javascript: XSS
    expect(isSafeLinkHref('java\nscript:alert(1)')).toBe(false);
    expect(isSafeLinkHref('java\tscript:alert(1)')).toBe(false);
    expect(isSafeLinkHref('java\rscript:alert(1)')).toBe(false);
    expect(isSafeLinkHref('java\fscript:alert(1)')).toBe(false);
    // 「插入链接」粘贴含 Tab 的值同理（粘贴面无 CommonMark 解码也照样进来）
    expect(isSafeLinkHref(' \t javascript:alert(1)')).toBe(false);
    // 保守口径：相对路径里的控制字符也拒绝（URL 本就不该有）
    expect(isSafeLinkHref('docs\ta.md')).toBe(false);
    expect(isSafeLinkHref('java\u0000script:alert(1)')).toBe(false);
  });

  test('正常链接不受影响', () => {
    expect(isSafeLinkHref('https://example.com')).toBe(true);
    expect(isSafeLinkHref('http://example.com')).toBe(true);
    expect(isSafeLinkHref('mailto:a@b.com')).toBe(true);
    expect(isSafeLinkHref('./page.md')).toBe(true);
    expect(isSafeLinkHref('#anchor')).toBe(true);
    expect(isSafeLinkHref('docs/guide.html')).toBe(true);
  });

  test('危险协议与空值仍拒绝', () => {
    expect(isSafeLinkHref('javascript:alert(1)')).toBe(false);
    expect(isSafeLinkHref('data:text/html;base64,xxx')).toBe(false);
    expect(isSafeLinkHref('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeLinkHref('file:///C:/x.html')).toBe(false);
    expect(isSafeLinkHref('')).toBe(false);
  });
});

test.describe('util/escape：escapeHtml', () => {
  test('五种字符全转义（含单引号 → &#39;）', () => {
    expect(escapeHtml(`<a href="x" title='y'>&`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;'
    );
  });

  test('& 先行转义（不产生二次替换）', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
    expect(escapeHtml("it's <b>&</b>")).toBe('it&#39;s &lt;b&gt;&amp;&lt;/b&gt;');
  });
});
