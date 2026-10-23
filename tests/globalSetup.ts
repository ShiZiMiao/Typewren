import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/* ============================================================
 * e2e 构建防呆：Playwright 跑的是 out/ 产物，改源码后忘记
 * `npm run build` 会被陈旧构建误导（修复批次实际踩过一轮）。
 * 开跑前比对 src/ 与 out/ 的最新修改时间，过期即报错退出。
 * ============================================================ */

/** 递归收集目录下文件的最新 mtime（目录不存在/为空抛错） */
function newestMtime(dir: string): number {
  const stat = statSync(dir);
  let newest = stat.mtimeMs;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
    } else if (entry.isFile()) {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

export default function globalSetup(): void {
  const root = process.cwd();
  const outTime = newestMtime(join(root, 'out'));
  const srcTime = Math.max(
    newestMtime(join(root, 'src')),
    statSync(join(root, 'package.json')).mtimeMs,
    statSync(join(root, 'electron.vite.config.ts')).mtimeMs
  );
  if (srcTime > outTime) {
    throw new Error(
      '[typewren e2e] src/（或构建配置）比 out/ 新，e2e 会跑陈旧构建。' +
        '请先执行 `npm run build` 再跑测试。'
    );
  }
}
