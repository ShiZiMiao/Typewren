// 回归验证：加载真实的 strikethroughFix.ts（Node 24 原生剥离 TS 类型），
// 用 mock ctx 捕获其写入 remark-stringify 的 handlers，走真实 remark 管线跑用例。
// 同时复刻 actions.ts getMarkdown 的“放宽→回读→严格兜底”算法做 doc 级校验用例。
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { remarkStringifyOptionsCtx, parserCtx } from '@milkdown/kit/core';
import { remarkGFMPlugin } from '@milkdown/kit/preset/gfm';
import {
  applyStrikethroughFixes,
  escapeTracking
} from '../src/renderer/src/editor/strikethroughFix.ts';

const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);

/** 递归删除 position（from-markdown 不认 position:false，手动剔除以便全等比较） */
function stripPosition(node) {
  for (const key of Object.keys(node)) {
    if (key === 'position') delete node[key];
    else if (node[key] && typeof node[key] === 'object') stripPosition(node[key]);
  }
  return node;
}

const makeParse = () =>
  unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath);

const toTree = (md) => stripPosition(makeParse().parse(md));

/** 与 actions.getMarkdown 一致：只比较文本内容（结构往返差异不误判） */
function textContentOf(ast) {
  let out = '';
  const walk = (node) => {
    if (node.type === 'text') out += node.value ?? '';
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object' && v.type) walk(v);
    }
  };
  walk(ast);
  return out;
}

// ---- mock ctx ----
const captured = { gfm: { singleTilde: true }, stringify: { handlers: {} } };
const mockCtx = {
  update: (id, updater) => {
    if (id === remarkGFMPlugin.options.key) {
      captured.gfm = updater(captured.gfm);
    } else if (id === remarkStringifyOptionsCtx) {
      captured.stringify = updater(captured.stringify);
    } else {
      throw new Error('unknown ctx ' + String(id));
    }
  },
  get: (id) => {
    if (id === parserCtx) return (md) => toTree(md);
    throw new Error('unknown ctx get ' + String(id));
  }
};
applyStrikethroughFixes(mockCtx);

// ---- 复刻 actions.getMarkdown：放宽 → 回读校验 → 不等则严格兜底 ----
function getMarkdownShim(md) {
  const originTree = toTree(md);
  const stringify = (opts) =>
    unified()
      .use(remarkParse)
      .use(remarkGfm, captured.gfm)
      .use(remarkStringify, opts)
      .processSync(md)
      .toString();

  escapeTracking.strict = false;
  escapeTracking.relaxed = false;
  let out = stringify(captured.stringify);
  if (escapeTracking.relaxed) {
    escapeTracking.strict = true;
    try {
      if (textContentOf(toTree(out)) !== textContentOf(originTree)) {
        out = stringify(captured.stringify);
      }
    } finally {
      escapeTracking.strict = false;
    }
  }
  return out.replace(/\n$/, '');
}

const cases = [
  // name, input(文件内容), 期望序列化输出
  ['bashrc', '~/.bashrc', '~/.bashrc'],
  ['heading-range', 'H1~H4', 'H1~H4'],
  ['strike', '~~删除~~', '~~删除~~'],
  ['pair-raw', 'a~~b', 'a~~b'],
  ['pair-escaped', 'a' + BS + '~' + BS + '~b', 'a~~b'],
  ['underscore', 'foo_bar', 'foo_bar'],
  ['underscore-multi', 'snake_case_name', 'snake_case_name'],
  ['asterisk-intraword', 'a' + BS + '*b', 'a*b'],
  ['emphasis-literal', BS + '*b' + BS + '*', BS + '*b' + BS + '*'],
  ['underscore-literal', BS + '_a' + BS + '_', BS + '_a' + BS + '_'],
  ['heading-literal', BS + '# foo', BS + '# foo'],
  [
    'code-fence',
    '```' + NL + '~/.bashrc  ~~x~~  a_b *z*' + NL + '```',
    '```' + NL + '~/.bashrc  ~~x~~  a_b *z*' + NL + '```'
  ],
  ['inline-code', '`~/.bashrc ~~x~~ a_b *z*`', '`~/.bashrc ~~x~~ a_b *z*`'],
  ['cross-node-fallback', 'a~~b ~~c~~', 'a' + BS + '~' + BS + '~b ~~c~~'],
  ['number-dots', '1.2.3', '1.2.3']
  // 已知限制（既有行为，与本次修复无关）：remark 不转义 `$`，故文本里的 `$x$`
  // 序列化后仍是 `$x$`（math 插件下会被解析为数学节点）。safe() 无 $ 规则，
  // 严格兜底也无法修复，属应用层遗留，另行处理。
];

const failures = [];
const report = [];
for (const [name, input, expected] of cases) {
  const out = getMarkdownShim(input);
  report.push({ name, input, out, expected, pass: out === expected });
  if (out !== expected) failures.push({ name, input, out, expected });
}

// 删除线 AST 仍解析为 delete 节点
const strikeAst = toTree('~~x~~');
const isDelete = strikeAst.children[0].children[0].type === 'delete';
report.push({ name: 'strike-ast', pass: isDelete });
if (!isDelete) failures.push({ name: 'strike-ast', detail: 'delete node missing' });

// 真实文件回归：D:/test.md（引用块 + 列表 + _/~ 混合，含原文自带转义 D1\~D2）
// 单元层复刻的是“序列化路径”（编辑后/保存前状态）：字节级原样由
// sourceMode.spec 的 e2e 覆盖（干净态显示磁盘原文），这里只断言语义无损：
// 文本内容一致，且文件里“不带转义的 ~/_”未被加转义。
import { readFileSync } from 'node:fs';
const realMd = readFileSync('D:/test.md', 'utf-8').replace(/\r\n/g, '\n');
const realOut = getMarkdownShim(realMd.replace(/\n+$/, ''));
const realOk =
  textContentOf(toTree(realOut)) === textContentOf(toTree(realMd)) && !realOut.includes('\\_');
report.push({ name: 'real-file', pass: realOk, out: realOut });
if (!realOk) failures.push({ name: 'real-file', detail: 'output != original', out: realOut });

console.log(JSON.stringify({ failures, report }, null, 2));
if (failures.length > 0) process.exitCode = 1;
