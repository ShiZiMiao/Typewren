import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeApp, launchApp, loadContent, sendCommand, type AppHandle } from './helpers';

/* ============================================================
 * <InteractiveQuiz …/> 答题卡片回归：
 * 1. script 里的 quizData 安全解析（无 eval）→ 卡片渲染
 *    （Q 徽标 + 选项），script 块本身隐藏；
 * 2. 选项点击选中，正确/错误着色；
 * 3. roundtrip：保存后 <InteractiveQuiz …/> 原文保留；
 * 4. 无 quizData 时回退原样文本（不静默丢失）。
 * ============================================================ */

const QUIZ_FIXTURE = `---
title: 自测题示例
---

# 自测题

## 🦖 交互式自测（推荐）

<script setup>
const quizData = [
  {
    question: '梯度消失问题的根本原因是什么？',
    type: 'single',
    options: [
      { label: 'A', text: '学习率设置太小' },
      { label: 'B', text: '深层网络中激活值的分布随层数变化而失控' },
      { label: 'C', text: '优化器选择不当' },
      { label: 'D', text: '数据集太小' }
    ],
    correct: [1],
    explanation: \`
      <strong>正确答案： B</strong><br><br>
      <ul>
        <li>当标准差变得非常小（接近 0）时，反向传播的梯度也会变小</li>
      </ul>
    \`
  },
  {
    question: 'RMSNorm vs LayerNorm 有什么区别？',
    type: 'single',
    options: [
      { label: 'A', text: 'RMSNorm 把均值减掉' },
      { label: 'B', text: 'RMSNorm 只做方差归一化减去均值' },
      { label: 'C', text: 'RMSNorm 更接近 Transformer' },
      { label: 'D', text: '没区别' }
    ],
    correct: [0],
    explanation: '不在卡片中展示'
  }
]
</script>

<InteractiveQuiz :questions="quizData" quiz-id="normalization" />
`;

/** 多组件/多数据块：按出现顺序一一对应（回归：旧实现只认第一个数据块） */
const MULTI_FIXTURE = `# 多组件

<script setup>
const quizData = [
  { question: '第一题？', type: 'single', options: [{ label: 'A', text: '甲' }], correct: [0] }
]
</script>

<InteractiveQuiz :questions="quizData" quiz-id="one" />

<script setup>
const questions = [
  { question: '第二题？', type: 'single', options: [{ label: 'B', text: '乙' }], correct: [0] }
]
</script>

<InteractiveQuiz :questions="questions" quiz-id="two" />
`;

const PLAIN_FIXTURE = `# 无数据

<InteractiveQuiz :questions="quizData" quiz-id="none" />

正文段落
`;

/** 变量名变体：站点脚本常见写作 questions 而非 quizData（通用性回归） */
const QUESTIONS_FIXTURE = `# 变体测试

<script setup>
const questions = [
  {
    question: 'SwiGLU 使用几个投影矩阵？',
    type: 'single',
    options: [
      { label: 'A', text: '1 个' },
      { label: 'B', text: '2 个' },
      { label: 'C', text: '3 个' },
      { label: 'D', text: '4 个' }
    ],
    correct: [2],
    explanation: '三个矩阵：W1/W2 的投影与门控'
  }
]
</script>

<InteractiveQuiz :questions="questions" quiz-id="swiglu" />
`;

let app: AppHandle;
let dir: string;

test.beforeAll(async () => {
  app = await launchApp();
  dir = mkdtempSync(join(tmpdir(), 'typewren-quiz-test-'));
});

test.afterAll(async () => {
  await closeApp(app);
  rmSync(dir, { recursive: true, force: true });
});

test('quizData 安全解析并渲染答题卡片（script 隐藏）', async () => {
  await loadContent(app, QUIZ_FIXTURE);

  const cards = app.window.locator('.typewren-quiz .quiz-card');
  await expect(cards).toHaveCount(2);

  // Q1 徽标 + 题面（textContent 渲染，无 HTML 注入）
  const first = cards.first();
  await expect(first.locator('.quiz-badge')).toHaveText('Q1');
  await expect(first.locator('.quiz-question')).toContainText('梯度消失问题的根本原因是什么？');

  // 选项：A-D 与文本
  const options = first.locator('.quiz-option');
  await expect(options).toHaveCount(4);
  await expect(first.locator('.quiz-option-label')).toHaveText(['A', 'B', 'C', 'D']);
  await expect(first.locator('.quiz-option-text').nth(1)).toContainText(
    '深层网络中激活值的分布随层数变化而失控'
  );

  // script 块继续按浏览器行为隐藏
  const bodyText = await app.window.locator('.ProseMirror').evaluate((el) => el.textContent ?? '');
  expect(bodyText).not.toContain('const quizData');
  // 原始组件标签不再以文本出现（被卡片节点替代）
  expect(bodyText).not.toContain('<InteractiveQuiz');
});

test('选项点击选中：正确绿 / 错误红，再点取消', async () => {
  await loadContent(app, QUIZ_FIXTURE);

  // Q1 正确答案是选项 1（B）
  const first = app.window.locator('.typewren-quiz .quiz-card').first();
  await first.locator('.quiz-option').nth(1).click();
  await expect(first.locator('.quiz-option').nth(1)).toHaveClass(/selected/);
  await expect(first.locator('.quiz-option').nth(1)).toHaveClass(/correct/);
  // 未选项不受影响
  await expect(first.locator('.quiz-option').nth(0)).not.toHaveClass(/selected/);

  // 换选错误项：正确项取消、错误项着色
  await first.locator('.quiz-option').nth(0).click();
  await expect(first.locator('.quiz-option').nth(0)).toHaveClass(/selected/);
  await expect(first.locator('.quiz-option').nth(0)).toHaveClass(/wrong/);
  await expect(first.locator('.quiz-option').nth(1)).not.toHaveClass(/selected/);

  // 再点一次当前项取消选中（解析说明同步收起）
  await first.locator('.quiz-option').nth(0).click();
  await expect(first.locator('.quiz-option').nth(0)).not.toHaveClass(/selected|correct|wrong/);
  await expect(first.locator('.quiz-explanation')).not.toHaveClass(/visible/);
});

test('选中选项后显示解析说明（HTML 净化真渲染，未选中隐藏）', async () => {
  await loadContent(app, QUIZ_FIXTURE);

  const first = app.window.locator('.typewren-quiz .quiz-card').first();
  const explanation = first.locator('.quiz-explanation');
  await expect(explanation).not.toHaveClass(/visible/);

  // 点击任意选项 → 解析出现（Q1 的 explanation 含 HTML）
  await first.locator('.quiz-option').nth(1).click();
  await expect(explanation).toHaveClass(/visible/);
  await expect(explanation.locator('.quiz-explanation-body strong')).toHaveText('正确答案： B');
  await expect(explanation.locator('.quiz-explanation-body ul li')).toHaveCount(1);
  await expect(explanation.locator('.quiz-explanation-body ul li')).toContainText(
    '当标准差变得非常小（接近 0）时'
  );
  // 文案中的 HTML 标签以真实元素呈现而非转义文本
  const rawText = await explanation
    .locator('.quiz-explanation-body')
    .evaluate((el) => el.innerHTML);
  expect(rawText).not.toContain('&lt;strong&gt;');

  // 再点当前项取消 → 解析收起
  await first.locator('.quiz-option').nth(1).click();
  await expect(explanation).not.toHaveClass(/visible/);

  // Q2 的 explanation 是纯文本（非 HTML）——选中后同区域显示文本
  const second = app.window.locator('.typewren-quiz .quiz-card').nth(1);
  await second.locator('.quiz-option').nth(0).click();
  await expect(second.locator('.quiz-explanation')).toHaveClass(/visible/);
  await expect(second.locator('.quiz-explanation-body')).toHaveText('不在卡片中展示');
});

test('变量名变体：const questions = [...] 同样渲染', async () => {
  await loadContent(app, QUESTIONS_FIXTURE);

  const cards = app.window.locator('.typewren-quiz .quiz-card');
  await expect(cards).toHaveCount(1);
  await expect(cards.first().locator('.quiz-question')).toContainText('SwiGLU 使用几个投影矩阵？');
  await cards.first().locator('.quiz-option').nth(2).click();
  await expect(cards.first().locator('.quiz-option').nth(2)).toHaveClass(/correct/);
  await expect(cards.first().locator('.quiz-explanation')).toHaveClass(/visible/);
  await expect(cards.first().locator('.quiz-explanation-body')).toHaveText(
    '三个矩阵：W1/W2 的投影与门控'
  );
});

test('多组件/多数据块按出现顺序对应', async () => {
  await loadContent(app, MULTI_FIXTURE);

  const cards = app.window.locator('.typewren-quiz .quiz-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).locator('.quiz-question')).toContainText('第一题？');
  await expect(cards.nth(1).locator('.quiz-question')).toContainText('第二题？');
  await expect(cards.nth(0).locator('.quiz-option-text')).toHaveText(['甲']);
  await expect(cards.nth(1).locator('.quiz-option-text')).toHaveText(['乙']);
});

test('无 quizData 时 InteractiveQuiz 回退原样文本', async () => {
  await loadContent(app, PLAIN_FIXTURE);

  await expect(app.window.locator('.typewren-quiz .quiz-card')).toHaveCount(0);
  await expect(app.window.locator('.ProseMirror')).toContainText(
    '<InteractiveQuiz :questions="quizData" quiz-id="none" />'
  );
});

test('保存 roundtrip：<InteractiveQuiz/> 原始标签保留', async () => {
  const filePath = join(dir, 'quiz-roundtrip.md');
  writeFileSync(filePath, QUIZ_FIXTURE, 'utf-8');
  await loadContent(app, QUIZ_FIXTURE, filePath);

  // 点击尾部段落后输入（与真实使用一致；Ctrl+End 会停在 quiz 原子节点上，
  // 快速输入走 PM"替换节点"竞态，见 createEditor 的 handleKeyDown 注释）
  await app.window.locator('.ProseMirror > p').last().click();
  await app.window.keyboard.type('roundtrip 校验。');
  await expect(app.window.locator('.ProseMirror')).toContainText('roundtrip 校验');
  // 卡片保活（未被输入替换）
  await expect(app.window.locator('.typewren-quiz .quiz-card')).toHaveCount(2);
  await app.window.waitForTimeout(300);
  await sendCommand(app, 'save');

  await expect
    .poll(() => readFileSync(filePath, 'utf-8'), { timeout: 8000 })
    .toContain('roundtrip 校验');

  const saved = readFileSync(filePath, 'utf-8');
  // 卡片节点序列化回原始组件标签（数据仍在 script 里，不重复/不丢失）
  expect(saved).toContain('<InteractiveQuiz :questions="quizData" quiz-id="normalization" />');
  expect(saved).toContain('const quizData = [');
  // 重新加载后仍渲染为卡片
  const reloaded = readFileSync(filePath, 'utf-8');
  await sendCommand(app, 'open-file-path', { path: filePath, content: reloaded });
  await expect(app.window.locator('.typewren-quiz .quiz-card')).toHaveCount(2);
});

test('源码往返后卡片就地更新：交互态保留、删除无孤儿 DOM', async () => {
  await loadContent(app, QUIZ_FIXTURE);

  // 先选中一个选项（交互态）
  const first = app.window.locator('.typewren-quiz .quiz-card').first();
  await first.locator('.quiz-option').nth(1).click();
  await expect(first.locator('.quiz-option').nth(1)).toHaveClass(/selected/);

  // 源码模式改无关内容 → 退出（setMarkdown 触发 NodeView.update）
  await sendCommand(app, 'view:source');
  await app.window.waitForTimeout(600);
  await app.window.locator('#source-textarea').click();
  await app.window.keyboard.type('，无关编辑');
  await app.window.waitForTimeout(250);
  await sendCommand(app, 'view:source');
  await app.window.waitForTimeout(600);

  // update 就地重建：同数据不重建，选项选中态不被打断
  await expect(app.window.locator('.typewren-quiz .quiz-card')).toHaveCount(2);
  await expect(first.locator('.quiz-option').nth(1)).toHaveClass(/selected/);
  // 交互仍生效（换选着色）
  await first.locator('.quiz-option').nth(0).click();
  await expect(first.locator('.quiz-option').nth(0)).toHaveClass(/wrong/);

  // 删除卡片节点：NodeView dom 若在 update 里被换新（PM 持旧引用），
  // 删除只摘掉悬空旧节点、可见卡片残留成孤儿——必须归零
  await first.locator('.quiz-head').click();
  await app.window.keyboard.press('Backspace');
  await expect(app.window.locator('.typewren-quiz')).toHaveCount(0);
});
