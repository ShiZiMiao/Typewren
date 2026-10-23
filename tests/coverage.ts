import type { CDPSession, ElectronApplication, Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* ============================================================
 * V8 覆盖率采集（TW_COV=1 时启用）
 * - 渲染层：每个窗口经 CDP Profiler.startPreciseCoverage 收集，
 *   closeApp 前 takePreciseCoverage 落盘；
 * - 主进程：electron.launch 注入 NODE_V8_COVERAGE（进程退出时
 *   V8 自动写 raw 覆盖）；Playwright worker（unit.spec 在 Node 侧
 *   import src 纯模块）由 test:cov 包装脚本同样注入；
 * - 产物落 <TW_COV_DIR>/*.json，scripts/coverage-report.mjs 经
 *   v8-to-istanbul + out/ sourcemap 映射回 src/ 的 TS 源文件 出报表。
 * 覆盖缺口的已知边界：taskkill 强杀（崩溃恢复用例）与已关闭多窗口
 * 的进程覆盖取不回来——它们的行会如实显示为未覆盖。
 * ============================================================ */

export function coverageEnabled(): boolean {
  return !!process.env.TW_COV;
}

export function coverageDir(): string {
  return process.env.TW_COV_DIR || join(process.cwd(), '.coverage-raw');
}

let seq = 0;

/** 可 attach 的会话集合（每 ElectronApplication 一组） */
const sessions = new WeakMap<ElectronApplication, Set<CDPSession>>();

async function attachPage(app: ElectronApplication, page: Page): Promise<void> {
  if (!coverageEnabled()) return;
  try {
    const client = await page.context().newCDPSession(page);
    await client.send('Profiler.enable');
    await client.send('Profiler.startPreciseCoverage', {
      callCount: true,
      detailed: true
    });
    let set = sessions.get(app);
    if (!set) {
      set = new Set();
      sessions.set(app, set);
    }
    set.add(client);
    client.on('Inspector.targetCrashed', () => set?.delete(client));
  } catch {
    // CDP 不可用（窗口已关/非 Chromium）时静默——覆盖率是尽力而为
  }
}

/** 启动采集：attach 首窗 + 订阅后续窗口（多窗口用例） */
export async function startCoverage(app: ElectronApplication, page: Page): Promise<void> {
  if (!coverageEnabled()) return;
  await attachPage(app, page);
  app.on('window', (w) => {
    void attachPage(app, w);
  });
}

/** 取回并落盘该实例全部窗口的精确覆盖（closeApp 前调用） */
export async function stopCoverage(app: ElectronApplication): Promise<void> {
  const set = sessions.get(app);
  if (!set || set.size === 0) return;
  mkdirSync(coverageDir(), { recursive: true });
  for (const client of set) {
    try {
      const { result } = (await client.send('Profiler.takePreciseCoverage')) as {
        result: unknown[];
      };
      seq += 1;
      writeFileSync(
        join(coverageDir(), `cov-renderer-${process.pid}-${seq}.json`),
        JSON.stringify({ result }),
        'utf-8'
      );
    } catch {
      // 目标已销毁：跳过
    }
    try {
      await client.send('Profiler.stopPreciseCoverage');
      await client.detach();
    } catch {
      // 忽略
    }
  }
  set.clear();
}

/** electron.launch 的 env 注入（NODE_V8_COVERAGE 收主进程覆盖） */
export function coverageLaunchEnv(): Record<string, string> | undefined {
  if (!coverageEnabled()) return undefined;
  return {
    ...(process.env as Record<string, string>),
    NODE_V8_COVERAGE: coverageDir()
  };
}
