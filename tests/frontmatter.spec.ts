import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeApp, launchApp, loadContent, sendCommand, type AppHandle } from './helpers';

/* ============================================================
 * Front Matter + Raw HTML 渲染回归：
 * 1. 文档开头 `--- ... ---` 元信息 → Typora 式浅灰卡片
 *    （原样 key: value 文本；无支持时被拆成 thematicBreak +
 *    setext 标题混入正文并污染大纲）；
 * 2. 原始 HTML：普通标签（details/strong 等）净化后真渲染，
 *    script/style 整块不执行、按代码块展示，未知标签（Vue
 *    组件）保留原文，危险内容（事件属性与 javascript: 链接）被剥离；
 * 3. 保存 roundtrip 保真：frontmatter 不丢、不被改写为 *** 分割线。
 * ============================================================ */

const FIXTURE = `---
title: Normalization 自测题 | minimind从零理解llm训练
description: 检验你对梯度消失、RMSNorm、Pre-LN 和 Post-LN 的理解程度。
keywords: Normalization自测题, 归一化测试
---

# Normalization 自测题

> 完成以下题目检验你的理解程度

## 🎮 交互式自测（推荐）

<script setup>
const quizData = [
  {
    question: '梯度消失问题的根本原因是什么？',
    type: 'single',
    correct: [1],
  },
]
</script>

<InteractiveQuiz :questions="quizData" quiz-id="normalization" />

## 综合问答题

<details>
<summary>点击查看参考答案</summary>

- 归一化通过控制每一层的激活分布来解决这个问题

</details>
`;

let app: AppHandle;
let dir: string;

/** 归一化大纲展开态（localStorage 会持久化，可能残留上一次测试的折叠态） */
async function ensureOutlineOpen(): Promise<void> {
  const collapsed = await app.window
    .locator('#app')
    .evaluate((el) => el.classList.contains('outline-collapsed'));
  if (collapsed) {
    await sendCommand(app, 'view:outline');
    await app.window.waitForTimeout(300);
  }
  const outlineActive = await app.window
    .locator('#side-panel .side-tab[data-tab="outline"]')
    .evaluate((el) => el.classList.contains('active'));
  if (!outlineActive) {
    await app.window.locator('#side-panel .side-tab[data-tab="outline"]').click();
    await app.window.waitForTimeout(200);
  }
}

test.beforeAll(async () => {
  app = await launchApp();
  dir = mkdtempSync(join(tmpdir(), 'typewren-fm-test-'));
});

test.afterAll(async () => {
  await closeApp(app);
  rmSync(dir, { recursive: true, force: true });
});

test('frontmatter 渲染为 Typora 式卡片，不再混入正文/大纲', async () => {
  await loadContent(app, FIXTURE);

  const card = app.window.locator('.ProseMirror .typewren-frontmatter');
  await expect(card).toHaveCount(1);
  // 原样 `key: value` 文本排版（Typora 式），不再是两列表格
  await expect(card.locator('.frontmatter-line')).toHaveText([
    'title: Normalization 自测题 | minimind从零理解llm训练',
    'description: 检验你对梯度消失、RMSNorm、Pre-LN 和 Post-LN 的理解程度。',
    'keywords: Normalization自测题, 归一化测试'
  ]);
  await expect(card.locator('table')).toHaveCount(0);

  // 不再以正文/标题文本形式出现（旧行为：setext 标题混入正文）——
  // 排除 frontmatter 卡片自身（卡片内本来就是 title: 原样文本）
  const bodyText = await app.window.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    if (!pm) return '';
    const clone = pm.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.typewren-frontmatter').forEach((el) => el.remove());
    return clone.textContent ?? '';
  });
  expect(bodyText).not.toContain('title: ');
  expect(bodyText).not.toContain('keywords: ');

  // 大纲面板不收录 frontmatter（旧行为：title 行变成大纲标题）
  await ensureOutlineOpen();
  const items = await app.window.locator('#outline-tree .outline-item').allTextContents();
  expect(items.join('\n')).not.toContain('title:');
  // 标题正常收录
  expect(items.join('\n')).toContain('Normalization 自测题');
});

test('raw HTML：script 按浏览器行为隐藏，details 真折叠（收起/展开），未知标签保留原文', async () => {
  await loadContent(app, FIXTURE);

  // script/style 整块：浏览器行为隐藏（不显示、不执行；内容经源码模式可见）
  await expect(app.window.locator('.ProseMirror pre.typewren-raw-html')).toHaveCount(0);
  const bodyText = await app.window.locator('.ProseMirror').evaluate((el) => el.textContent ?? '');
  expect(bodyText).not.toContain('const quizData');
  expect(bodyText).not.toContain('<script setup>');

  // details 真折叠块：内容被包进容器（可收起/展开）
  const details = app.window.locator('.ProseMirror details.typewren-details');
  await expect(details).toHaveCount(1);
  await expect(details.locator('summary')).toContainText('点击查看参考答案');
  // 默认收起：内容在 DOM 中但不可见（open 属性缺失）
  await expect(details).not.toHaveAttribute('open', '');
  const hidden = await details.evaluate((el) => {
    const body = el.querySelector('.typewren-details-body');
    return body ? getComputedStyle(body).display : 'none';
  });
  expect(hidden).toBe('none');
  // 内容（列表）确实在 details 容器内
  await expect(details).toContainText('归一化通过控制每一层的激活分布');

  // 点击 summary 展开 → 内容可见；再点收起
  await details.locator('summary').click();
  await expect(details).toHaveAttribute('open', '');
  await expect(details.locator('.typewren-details-body')).toBeVisible();
  await details.locator('summary').click();
  await expect(details).not.toHaveAttribute('open', '');

  // 未知标签（Vue 组件）无法渲染 → 原样文本保留（大小写/自闭合写法不丢）
  await expect(app.window.locator('.ProseMirror')).toContainText(
    '<InteractiveQuiz :questions="quizData" quiz-id="normalization" />'
  );
});

test('details open 默认展开态保留（roundtrip）', async () => {
  const OPEN_FIXTURE = `# 展开态

<details open>
<summary>默认展开</summary>

- 第一项
- 第二项

</details>

尾段落
`;
  const filePath = join(dir, 'details-open.md');
  writeFileSync(filePath, OPEN_FIXTURE, 'utf-8');
  await loadContent(app, OPEN_FIXTURE, filePath);

  const details = app.window.locator('.ProseMirror details.typewren-details');
  await expect(details).toHaveCount(1);
  await expect(details).toHaveAttribute('open', '');
  await expect(details.locator('.typewren-details-body')).toBeVisible();

  // 真实保存走序列化（干净文档的源码视图显示磁盘原文，验不到序列化）——
  // open 必须落回开标签，否则保存一次默认展开态就丢了
  await app.window.locator('.ProseMirror > p').last().click();
  await app.window.keyboard.type('触发序列化。');
  await sendCommand(app, 'save');
  await expect
    .poll(() => readFileSync(filePath, 'utf-8'), { timeout: 8000 })
    .toContain('触发序列化');
  const saved = readFileSync(filePath, 'utf-8');
  expect(saved).toContain('<details open>');
  expect(saved).toContain('<summary>默认展开</summary>');
  expect(saved).toContain('</details>');

  // 重载后默认展开态仍在
  await sendCommand(app, 'open-file-path', { path: filePath, content: saved });
  await expect(details).toHaveAttribute('open', '');
  await expect(details.locator('.typewren-details-body')).toBeVisible();
});

test('净化安全：危险标签不执行、事件/javascript: 不落 DOM', async () => {
  const SECURITY_FIXTURE = `<details>
<summary>安全测试</summary>

<img src="x" onerror="window.__xss = 1" />
<a href="javascript:window.__xss = 3">危险链接</a>
<script>window.__xss = 2</script>
</details>

正文段落
`;
  await loadContent(app, SECURITY_FIXTURE);

  // 事件属性被剥离、javascript: 链接被拒 → 无一执行
  await app.window.waitForTimeout(400);
  const xss = await app.window.evaluate(() => (globalThis as unknown as { __xss?: number }).__xss);
  expect(xss).toBeUndefined();
  await expect(app.window.locator('.ProseMirror img[onerror]')).toHaveCount(0);
  await expect(app.window.locator('.ProseMirror a[href^="javascript"]')).toHaveCount(0);

  // 危险标签：script 内容按浏览器行为隐藏（不执行、不展示）；其余危险标签只留文本
  await expect(app.window.locator('.ProseMirror')).not.toContainText('window.__xss = 2');
});

test('保存 roundtrip 保真：frontmatter 结构不被破坏', async () => {
  const filePath = join(dir, 'roundtrip.md');
  writeFileSync(filePath, FIXTURE, 'utf-8');
  await loadContent(app, FIXTURE, filePath);

  // 点击尾部段落后输入（Ctrl+End 会停在 quiz/详情原子节点上，快速输入
  // 走 PM"替换节点"竞态，与真实使用不一致）
  await app.window.locator('.ProseMirror > p').last().click();
  await app.window.keyboard.type('补充说明：roundtrip 校验行。');
  await expect(app.window.locator('.ProseMirror')).toContainText('roundtrip 校验行');
  await app.window.waitForTimeout(300);
  await sendCommand(app, 'save');

  await expect
    .poll(() => readFileSync(filePath, 'utf-8'), { timeout: 8000 })
    .toContain('roundtrip 校验行');

  const saved = readFileSync(filePath, 'utf-8');
  // frontmatter 完整保留：开头 --- 块原样闭合（旧行为会被拆成 *** 分割线）
  expect(saved.startsWith('---\n')).toBe(true);
  expect(saved).toMatch(/^---\ntitle: [^\n]*\ndescription: [^\n]*\nkeywords: [^\n]*\n---\n/m);
  expect(saved).not.toContain('***');
  // details 折叠块结构保真：summary + 内部列表 + 闭合标签（容器节点序列化往返；
  // 列表 bullet 允许 - / * —— mdast-util-to-markdown 默认选 *，语义等价）
  expect(saved).toMatch(
    /<details>\n<summary>点击查看参考答案<\/summary>\n\n(?:- |\* )归一化通过控制每一层的激活分布来解决这个问题\n<\/details>/
  );

  // 重新加载后仍渲染为卡片（序列化没有丢 yaml 结构），且基线一致不置脏
  const reloaded = readFileSync(filePath, 'utf-8');
  await sendCommand(app, 'open-file-path', { path: filePath, content: reloaded });
  await expect(app.window.locator('.ProseMirror .typewren-frontmatter')).toHaveCount(1);
  await expect(app.window.locator('#titlebar-title')).not.toContainText('●');
});
