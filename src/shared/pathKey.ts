import { resolve } from 'node:path';

/* ============================================================
 * 路径归一化纯函数（主进程多处共用）
 * pathKey 原先在 startup.ts 与 docRegistry.ts 各实现一份（win32 小写归一），
 * 口径漂移会让"同一文档"被判成两个 → 启动重复开窗 / 重复打开询问失灵。
 * ============================================================ */

/**
 * 路径比较键：绝对化后按平台归一大小写（Windows 文件路径大小写不敏感）。
 * 消费方：startup.ts 启动去重、docRegistry.ts 重复打开检测与最近文件去重。
 */
export function pathKey(p: string): string {
  const abs = resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * 待打开路径归一化：空串保持空串（未命名文档语义）。
 * 坑：resolve('') 返回 process.cwd()——把 cwd 绑成文档路径后，未命名草稿恢复出的
 * 文档"保存"会 EISDIR、草稿永远清不掉（drafts.spec 有回归）。空路径必须原样透传。
 */
export function absolutePathOrEmpty(p: string): string {
  return p ? resolve(p) : '';
}
