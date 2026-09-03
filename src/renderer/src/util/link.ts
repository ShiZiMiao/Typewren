/* ============================================================
 * 链接协议安全：href 白名单
 * 仅放行 http/https/mailto；无协议（相对路径 / 锚点）视为安全。
 * 插入命令与导出 HTML 共用，防止 javascript:/data: 等进入
 * <a href>（导出文件打开后即 XSS 面）。
 * ============================================================ */

export function isSafeLinkHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.length === 0) return false;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)?.[1]?.toLowerCase() ?? '';
  if (scheme === '') return true; // 相对路径 / 锚点 / 无协议写法
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}
