/* ============================================================
 * V8 覆盖率汇总报表（配合 tests/coverage.ts 的采集器）
 * 读 .coverage-raw/*.json（CDP 渲染层 + NODE_V8_COVERAGE 主进程/worker），
 * 经 v8-to-istanbul + out/ sourcemap 映射回 src/ 的 TS 源文件：
 * - 只统计 src/（不含 tests/、node_modules/）；
 * - 输出 text 报表 + 未执行语句的行号清单（补测试的靶子）。
 * 用法：node scripts/coverage-report.mjs
 * ============================================================ */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import covLib from 'istanbul-lib-coverage';
import reportLib from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import v8toIstanbul from 'v8-to-istanbul';

const { createCoverageMap } = covLib;
const { createContext } = reportLib;

const rawDir = process.env.TW_COV_DIR || resolve('.coverage-raw');
if (!existsSync(rawDir)) {
  console.error(`覆盖数据目录不存在：${rawDir}（先跑 npm run test:cov）`);
  process.exit(1);
}

/** 值得转换的脚本：自家产物（out/ 打包代码）与 src/ 直载（unit.spec 纯模块） */
function worthConverting(localPath) {
  const p = localPath.replace(/\\/g, '/');
  if (p.includes('/tests/')) return false;
  if (p.includes('/node_modules/')) return false;
  if (p.includes('/out/main/') || p.includes('/out/preload/')) return true;
  // 渲染层入口 chunk（含全部静态业务代码；mermaid 等动态 chunk 是纯 node_modules）
  if (p.includes('/out/renderer/assets/index')) return true;
  return p.includes('/src/');
}

function toLocalPath(url) {
  if (!url) return null;
  if (url.startsWith('file://')) {
    try {
      return fileURLToPath(url);
    } catch {
      return null;
    }
  }
  return url;
}

const map = createCoverageMap({});
let converted = 0;
const rawFiles = readdirSync(rawDir).filter((f) => f.endsWith('.json'));
for (const f of rawFiles) {
  let data;
  try {
    data = JSON.parse(readFileSync(join(rawDir, f), 'utf8'));
  } catch {
    continue;
  }
  for (const script of data.result ?? []) {
    const local = toLocalPath(script.url);
    if (!local || !worthConverting(local) || !existsSync(local)) continue;
    try {
      const converter = v8toIstanbul(local);
      await converter.load();
      // v8-to-istanbul 的 applyCoverage 直接收 functions 数组（每项含 ranges）
      converter.applyCoverage(script.functions ?? []);
      map.merge(converter.toIstanbul());
      converted += 1;
    } catch (e) {
      console.warn(`转换失败（跳过）：${local}：${e.message}`);
    }
  }
}

// 只留 src/（转换产物含 node_modules 原始源与三方 vendor）
const filtered = createCoverageMap({});
for (const [file, cov] of Object.entries(map.toJSON())) {
  const p = file.replace(/\\/g, '/');
  if (p.includes('/src/') && !p.includes('/node_modules/')) filtered.addFileCoverage(cov);
}

console.log(`\n转换脚本 ${converted} 个 / 原始覆盖文件 ${rawFiles.length} 个\n`);
const ctx = createContext({ coverageMap: filtered, dir: process.cwd() });
reports.create('text', { skipFull: false }).execute(ctx);
reports.create('text-summary').execute(ctx);

/* 未执行语句行清单（按文件，补测试用） */
console.log('\n===== 未执行语句行（每文件最多列 40 行）=====');
for (const [file, cov] of Object.entries(filtered.toJSON())) {
  const missed = new Set();
  for (const [id, stmt] of Object.entries(cov.statementMap)) {
    if (cov.s[id] === 0) missed.add(stmt.start.line);
  }
  if (missed.size === 0) continue;
  const lines = [...missed].sort((a, b) => a - b);
  const shown = lines.slice(0, 40).join(', ');
  const more = lines.length > 40 ? ` …共 ${lines.length} 行` : '';
  console.log(
    `${file.replace(/\\/g, '/').replace(process.cwd().replace(/\\/g, '/') + '/', '')}: ${shown}${more}`
  );
}
