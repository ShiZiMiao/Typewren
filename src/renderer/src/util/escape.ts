/* ============================================================
 * HTML 转义工具（KaTeX 错误回显 / 导出标题等场景复用）
 * ============================================================ */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
