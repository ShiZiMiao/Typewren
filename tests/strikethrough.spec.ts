import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/* ============================================================
 * 序列化“零多余转义”回归测试
 *
 * tests/strikethrough-check.mjs 加载真实的 strikethroughFix.ts
 * （Node 24 原生剥离 TS 类型 + mock ctx），跑真实 remark 管线，
 * 并复刻 actions.getMarkdown 的“放宽→回读→严格兜底”算法。
 * 本 spec 只负责执行并校验其 JSON 报告。
 * ============================================================ */

interface CaseReport {
  name: string;
  pass: boolean;
  out?: string;
  expected?: string;
}

interface CheckReport {
  failures: unknown[];
  report: CaseReport[];
}

function runCheck(): CheckReport {
  const stdout = execFileSync('node', ['tests/strikethrough-check.mjs'], {
    cwd: join(__dirname, '..'),
    encoding: 'utf-8'
  });
  return JSON.parse(stdout) as CheckReport;
}

test('源码模式序列化：全部用例无失败', () => {
  const report = runCheck();
  expect(report.failures).toEqual([]);
  expect(report.report.every((c) => c.pass)).toBe(true);
});

test('普通下划线/波浪线原样输出（不新增转义）', () => {
  const report = runCheck();
  const pick = (name: string): CaseReport => report.report.find((c) => c.name === name)!;
  expect(pick('bashrc').out).toBe('~/.bashrc');
  expect(pick('heading-range').out).toBe('H1~H4');
  expect(pick('underscore').out).toBe('foo_bar');
  expect(pick('underscore-multi').out).toBe('snake_case_name');
  expect(pick('pair-raw').out).toBe('a~~b');
  expect(pick('pair-escaped').out).toBe('a~~b');
});

test('删除线仍序列化为 ~~ 且 AST 是 delete 节点', () => {
  const report = runCheck();
  const strike = report.report.find((c) => c.name === 'strike')!;
  expect(strike.out).toBe('~~删除~~');
  expect(report.report.find((c) => c.name === 'strike-ast')!.pass).toBe(true);
});

test('字面强调/行首标题必须保留转义（防语义漂移）', () => {
  const report = runCheck();
  const pick = (name: string): CaseReport => report.report.find((c) => c.name === name)!;
  expect(pick('emphasis-literal').out).toBe('\\*b\\*');
  expect(pick('underscore-literal').out).toBe('\\_a\\_');
  expect(pick('heading-literal').out).toBe('\\# foo');
});

test('代码块与行内代码内容不受影响', () => {
  const report = runCheck();
  const pick = (name: string): CaseReport => report.report.find((c) => c.name === name)!;
  expect(pick('code-fence').out).toBe('```\n~/.bashrc  ~~x~~  a_b *z*\n```');
  expect(pick('inline-code').out).toBe('`~/.bashrc ~~x~~ a_b *z*`');
});

test('跨节点配对风险走严格兜底（a~~b 后跟删除线）', () => {
  const report = runCheck();
  const pick = (name: string): CaseReport => report.report.find((c) => c.name === name)!;
  // 文本 a~~b 与后文 ~~c~~ 若都按原样输出会拼成 a~~b~~c~~ 误删内容，
  // 整篇校验失败后回退为保留转义：a\~\~b ~~c~~
  expect(pick('cross-node-fallback').out).toBe('a\\~\\~b ~~c~~');
});
