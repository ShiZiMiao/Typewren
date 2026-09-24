/* ============================================================
 * 本地图片的自定义加载协议（编辑器显示用）
 *
 * 文档里的图片引用保持相对路径（./assets/xx.png，随文档移动），
 * 但渲染层页面基址是应用目录（dev 是 localhost、打包是 out/renderer），
 * 相对 src 永远解不到文档目录。这里统一把本地引用解析成
 *   typewren-img://local/<encodeURIComponent(绝对路径)>
 * 交给主进程协议处理器读盘返回；文档内容本身不动。
 * ============================================================ */

export const IMAGE_URL_SCHEME = 'typewren-img';

const URL_PREFIX = `${IMAGE_URL_SCHEME}://local/`;

/** 绝对路径 → 协议 URL（路径统一正斜杠，整体 encodeURIComponent 防分隔符歧义） */
export function toLocalImageUrl(absolutePath: string): string {
  return URL_PREFIX + encodeURIComponent(absolutePath.replace(/\\/g, '/'));
}

/** 协议 URL → 绝对路径；非本协议或解码失败返回 null */
export function fromLocalImageUrl(url: string): string | null {
  if (!url.toLowerCase().startsWith(URL_PREFIX)) return null;
  try {
    const path = decodeURIComponent(url.slice(URL_PREFIX.length));
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

/** 是否为本地图片协议 URL（已解析过的引用，无需再解析）。
 *  渲染层 imageView.ts 用它跳过"已解析引用"的二次解析，须保持导出。 */
export function isLocalImageUrl(url: string): boolean {
  return url.toLowerCase().startsWith(URL_PREFIX);
}

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * dir 与 rel 的简单拼合（渲染层无 node:path；'..' 上跳、'./' 与空段忽略）。
 * 坑：直接 join 会丢 POSIX 根——'/home/u/doc'.split 得到的首段是空串（根标记），
 * 被当空段丢掉后结果成 'home/u/doc/…'（非绝对路径，协议 400 拒，mac/Linux 下
 * 相对引用图片全挂）。拼合后必须把前导 '/' 加回去（Windows 驱动器号 'D:' 不受影响）。
 */
export function joinPath(dir: string, rel: string): string {
  const segments = [...dir.split(/[\\/]+/), ...rel.split(/[\\/]+/)];
  const rooted = dir.startsWith('/') || dir.startsWith('\\');
  const out: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      // 保留驱动器号（'D:'）/根层级，不往上层再弹
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(seg);
  }
  return (rooted ? '/' : '') + out.join('/');
}

/**
 * 把 Markdown 图片引用解析为可加载 URL：
 * - 已带协议（http/https/data/blob/file/typewren-img…）原样返回；
 * - Windows / POSIX 绝对路径 → 本地协议 URL；
 * - 相对引用（./assets/x.png）→ 以文档目录为基准解析；
 * - 无文档目录时相对引用无从解析，原样返回（浏览器按页面基址解析，自会 404）。
 */
export function resolveImageSrc(src: string, docDir: string | null): string {
  if (!src) return src;
  if (isLocalImageUrl(src)) return src;
  // 兼容历史引用：encodeURI 曾把反斜杠绝对路径编码成 C:%5CUsers%5C…，
  // 驱动器号仍形似 scheme，必须先于通用 scheme 判定转正
  if (/^[A-Za-z]:%5C/i.test(src)) return toLocalImageUrl(src.replace(/%5C/gi, '/'));
  // 驱动器号形似 scheme（C:/x 的 'C:'），必须排在通用 scheme 判定之前
  if (WINDOWS_ABSOLUTE.test(src) || src.startsWith('/')) return toLocalImageUrl(src);
  if (HAS_SCHEME.test(src)) return src;
  if (!docDir) return src;
  return toLocalImageUrl(joinPath(docDir, src.replace(/%5C/gi, '/')));
}
