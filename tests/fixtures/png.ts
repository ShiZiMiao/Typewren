/* ============================================================
 * 图片测试共用素材
 * 1x1 透明 PNG（合法 PNG 头 + 最小 IDAT），粘贴/拖拽/插入/下载用例共用；
 * imageDownload.spec 内的同名常量是他人文件，保持其原样不动。
 * ============================================================ */

/** 1x1 透明 PNG 的 base64 */
export const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** base64 → 可直接落盘的 Buffer */
export function pngBuffer(): Buffer {
  return Buffer.from(PNG_BASE64, 'base64');
}
