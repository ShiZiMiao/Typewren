/* ============================================================
 * 覆盖率驱动的完整测试跑（npm run test:cov）
 * 1) TW_COV=1 构建（带 sourcemap，覆盖映射回 src 用）；
 * 2) 注入 TW_COV / NODE_V8_COVERAGE 跑全量 e2e（含 unit.spec 的
 *    Node 侧 src 纯模块覆盖）；
 * 3) 汇总报表（scripts/coverage-report.mjs）。
 * ============================================================ */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const rawDir = resolve(process.env.TW_COV_DIR || '.coverage-raw');
rmSync(rawDir, { recursive: true, force: true });

const env = {
  ...process.env,
  TW_COV: '1',
  TW_COV_DIR: rawDir,
  NODE_V8_COVERAGE: rawDir
};

function run(label, cmd, args) {
  console.log(`\n[coverage] ${label} …`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: true });
  if (r.status !== 0) {
    console.error(`[coverage] ${label} 失败（exit ${r.status}）`);
    process.exit(r.status ?? 1);
  }
}

run('构建（TW_COV sourcemap）', 'npm', ['run', 'build']);
run('全量 e2e', 'npx', ['playwright', 'test']);
run('汇总报表', 'node', ['scripts/coverage-report.mjs']);
