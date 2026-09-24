/* ============================================================
 * 链接协议安全：href 白名单
 * 仅放行 http/https/mailto；无协议（相对路径 / 锚点）视为安全。
 * 插入命令与导出 HTML 共用，防止 javascript:/data: 等进入
 * <a href>（导出文件打开后即 XSS 面）。
 * ============================================================ */

/** URL 里绝不该出现的 ASCII 控制字符（含 \t \n \r \f）。
 * HTML URL 解析会**静默剥离**它们：`java\nscript:alert(1)` 浏览器实际按
 * `javascript:alert(1)` 解析执行——而 CommonMark 会把 `&#10;` 实体解码成
 * 真实 \n 再进到这里（`[x](java&#10;script:alert(1))`），「插入链接」粘贴
 * 含 Tab 的值同理。若只做"剥掉控制字符再提 scheme"，普通相对路径里的
 * 控制字符也会被悄悄合并改写；保守口径是**出现即拒绝**。
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function isSafeLinkHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.length === 0) return false;
  // 控制字符绕过防线（见 CONTROL_CHARS 注释）：必须先于 scheme 判定，
  // 否则 `java\nscript:` 会被正则在 \n 处断开、误判"无协议=安全"放行
  if (CONTROL_CHARS.test(trimmed)) return false;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)?.[1]?.toLowerCase() ?? '';
  if (scheme === '') return true; // 相对路径 / 锚点 / 无协议写法
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}
