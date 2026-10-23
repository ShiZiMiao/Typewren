import type { Root } from 'mdast';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { NodeView } from '@milkdown/kit/prose/view';
import { $nodeSchema, $remark, $view } from '@milkdown/kit/utils';

import { sanitizeHtml } from './htmlSanitize';
import { resolveImageSrc } from '../../../shared/imageUrl';
import { getImageDocDirProvider } from './imageView';

/** html 块内 img 的本地引用解析（与 imageView 同一口径；无文档目录时原样透传） */
function resolveHtmlImgSrc(src: string): string {
  return resolveImageSrc(src, getImageDocDirProvider()());
}

/* ============================================================
 * <InteractiveQuiz … /> 渲染为答题卡片（VitePress 站点形态）
 * minimind 式站点源码里，交互题数据放在 <script setup> 的
 * `const quizData = [...]`，组件标签只引用变量——编辑器无法
 * 执行 Vue，但可以**安全解析字面量**（无 eval、无 new Function）：
 * 本模块从 script 块提取 quizData，把 <InteractiveQuiz /> 节点
 * 替换为 interactive_quiz 节点，渲染成图 2 式卡片：
 * Q 徽标 + 题面 + 单选选项（点击选中，正确/错误着色）。
 * 序列化还原原始 `<InteractiveQuiz :questions="quizData" … />`
 * 标签（roundtrip 保真），数据仅供展示，内容不可编辑。
 * ============================================================ */

import { parseQuizData } from './quizDataParser';
import { markdownExtensionPlugin } from './markdownExtension';
import type { MdNode } from './mdastTypes';

/* ------------------------------------------------------------
 * mdast 层：script 块数据 + InteractiveQuiz 标签 → 卡片节点
 * ------------------------------------------------------------ */

/** InteractiveQuiz 目标节点的 raw 文本（顶层 html 或纯 html 段落内） */
function interactiveTag(node: MdNode): string | null {
  if (node.type === 'html') return node.value ?? null;
  if (
    node.type === 'paragraph' &&
    Array.isArray(node.children) &&
    node.children.length === 1 &&
    node.children[0].type === 'html'
  ) {
    return node.children[0].value ?? null;
  }
  return null;
}

/** 可渲染为答题卡片的组件标签（站点侧注册名；新增组件名只需加到此表） */
const INTERACTIVE_COMPONENT_TAGS = ['InteractiveQuiz'];

const INTERACTIVE_RE = new RegExp(`^\\s*<${INTERACTIVE_COMPONENT_TAGS.join('|')}\\b`, 'i');

/** 递归替换 InteractiveQuiz 节点（兄弟层循环） */
function replaceQuizNodes(nodes: MdNode[]): MdNode[] {
  // 收集文档内所有 script 块的 quizData（不区分构造顺序）
  const allQuizData: Record<string, unknown>[][] = [];
  const collect = (list: MdNode[]): void => {
    for (const n of list) {
      if (n.type === 'html' && typeof n.value === 'string') {
        const first = (n.value.match(/^\s*<(script|style)\b/i) ?? [])[0];
        if (first) {
          const data = parseQuizData(n.value);
          if (data) allQuizData.push(data);
        }
      }
      if (Array.isArray(n.children)) collect(n.children);
    }
  };
  collect(nodes);

  let dataIndex = 0;
  const walk = (list: MdNode[]): MdNode[] => {
    const out: MdNode[] = [];
    for (const n of list) {
      const tag = interactiveTag(n);
      if (tag && INTERACTIVE_RE.test(tag) && allQuizData.length > 0) {
        // 多组件/多数据块：按出现顺序一一对应（超出数据块数时复用最后一个）
        const data = allQuizData[Math.min(dataIndex, allQuizData.length - 1)];
        dataIndex++;
        out.push({ type: 'interactiveQuiz', value: tag, data });
        continue;
      }
      if (Array.isArray(n.children)) n.children = walk(n.children);
      out.push(n);
    }
    return out;
  };
  return walk(nodes);
}

/** $remark 插件：InteractiveQuiz → interactiveQuiz 节点 */
export const interactiveQuizRemarkPlugin = $remark('QUIZ_REMARK', () => {
  return function quizMerge() {
    return function quizTransformer(tree: Root): void {
      tree.children = replaceQuizNodes(
        tree.children as unknown as MdNode[]
      ) as unknown as Root['children'];
    };
  };
});

/** mdast → markdown 的 interactiveQuiz 序列化 handler（还原原始标签） */
const interactiveQuizMarkdownExtension = {
  handlers: {
    interactiveQuiz(node: Record<string, unknown>): string {
      return String(node.value ?? '');
    }
  }
};

/** $remark 插件：挂载 interactiveQuiz 的 markdown 序列化 handler
 * （同 details：必须在插件主体执行时写入 data，transformer 里写不生效） */
export const interactiveQuizStringifyPlugin = markdownExtensionPlugin(
  'QUIZ_STRINGIFY',
  interactiveQuizMarkdownExtension
);

/* ------------------------------------------------------------
 * Schema：交互卡片（原子节点，数据 JSON 存 attrs，value 存原文标签）
 * ------------------------------------------------------------ */

export const interactiveQuizSchema = $nodeSchema('interactive_quiz', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  defining: true,
  isolating: true,
  attrs: {
    data: { default: '[]', validate: 'string' },
    tag: { default: '', validate: 'string' }
  },
  parseDOM: [
    {
      tag: 'div[data-quiz]',
      getAttrs: (dom) => ({
        data: (dom as HTMLElement).getAttribute('data-quiz') ?? '[]',
        tag: (dom as HTMLElement).getAttribute('data-tag') ?? ''
      })
    }
  ],
  // 导出用（编辑器走 NodeView）：静态镜像卡片（题目/选项文本全量序列化），
  // 保证导出 HTML/PDF 不丢卡片内容；交互仅为运行时行为，不进导出
  toDOM: (node) => buildQuizDom(node.attrs.data as string),
  parseMarkdown: {
    match: ({ type }) => type === 'interactiveQuiz',
    runner: (state, node, type) => {
      const n = node as unknown as { value?: string; data?: unknown };
      state.addNode(type, {
        data: JSON.stringify(n.data ?? []),
        tag: n.value ?? ''
      });
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'interactive_quiz',
    runner: (state, node) => {
      // value = 原始 <InteractiveQuiz …/> 标签，roundtrip 保真
      state.addNode('interactiveQuiz', undefined, node.attrs.tag as string);
    }
  }
}));

/* ------------------------------------------------------------
 * NodeView：答题卡片渲染 + 选项交互
 * ------------------------------------------------------------ */

interface QuizOption {
  label?: string;
  text?: string;
}
interface QuizQuestion {
  question?: string;
  type?: string;
  options?: QuizOption[];
  correct?: number[];
  explanation?: string;
}

class QuizView implements NodeView {
  dom: HTMLElement;
  private questions: QuizQuestion[] = [];
  private renderedData: string | null = null;

  constructor(private node: ProseNode) {
    this.dom = document.createElement('div');
    this.dom.className = 'typewren-quiz';
    this.dom.setAttribute('contenteditable', 'false');
    // 委托监听只挂一次（update 就地重建内容，重复 addEventListener 会叠加）
    this.dom.addEventListener('click', (event) => this.onClick(event));
    this.render(node.attrs.data as string);
  }

  /** 就地重建内容：PM 持有创建时的 dom 引用，update 里换新元素
   * 会让引用悬空（定位/删除错乱），只允许改内部内容。
   * 同数据不重建——无关编辑触发的 update 不打断选项选中态 */
  private render(dataJson: string): void {
    if (this.renderedData === dataJson) return;
    this.renderedData = dataJson;
    this.dom.setAttribute('data-quiz', dataJson);
    this.dom.replaceChildren();
    this.questions = populateQuizContent(this.dom, dataJson);
  }

  private onClick(event: Event): void {
    const target = event.target as HTMLElement;
    const option = target.closest<HTMLElement>('.quiz-option');
    if (!option || !this.dom.contains(option)) return;
    const card = option.closest<HTMLElement>('.quiz-card');
    if (!card) return;
    const optionIndex = Number(option.dataset.index ?? '-1');
    if (optionIndex < 0) return;
    const wasSelected = option.classList.contains('selected');
    card.querySelectorAll('.quiz-option').forEach((el) => {
      el.classList.remove('selected', 'correct', 'wrong');
    });
    if (wasSelected) {
      // 再点取消：解析说明同步收起
      const explanationBox = card.querySelector<HTMLElement>('.quiz-explanation');
      if (explanationBox) explanationBox.classList.remove('visible');
      return;
    }
    option.classList.add('selected');
    const cardIndex = Number(card.dataset.index ?? '-1');
    const question = this.questions[cardIndex];
    if (question && Array.isArray(question.correct) && question.correct.includes(optionIndex)) {
      option.classList.add('correct');
    } else {
      option.classList.add('wrong');
    }
    // 选中即展示解析说明（未选中态隐藏）
    const explanationBox = card.querySelector<HTMLElement>('.quiz-explanation');
    if (explanationBox) {
      explanationBox.classList.toggle('visible', Boolean(question?.explanation));
    }
  }

  update(nextNode: ProseNode): boolean {
    if (nextNode.type !== this.node.type) return false;
    this.node = nextNode;
    this.render(nextNode.attrs.data as string);
    return true;
  }

  /** 选项点击是卡片自身的交互，不交给 PM */
  stopEvent(event: Event): boolean {
    const target = event.target as HTMLElement;
    return target.closest('.quiz-option') !== null;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.dom.remove();
  }
}

const ANSWER_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

/** 构建解析说明区域：HTML 走公共净化器（htmlSanitize），纯文本原样 */
function buildExplanation(explanation: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'quiz-explanation';
  const label = document.createElement('div');
  label.className = 'quiz-explanation-label';
  label.textContent = '解析';
  box.appendChild(label);
  const body = document.createElement('div');
  body.className = 'quiz-explanation-body';
  if (explanation.trim().length > 0) {
    const result = sanitizeHtml(explanation, resolveHtmlImgSrc);
    if (result.kind === 'html') {
      body.appendChild(result.fragment);
    } else {
      // 空/整块危险标签：以纯文本展示（不执行、不静默丢失）
      body.textContent = explanation;
    }
  }
  box.appendChild(body);
  return box;
}

/** 归一化题目条目（quizData 里混入 null/裸值时不崩溃，降级为空题面） */
function normalizeQuestion(raw: unknown): QuizQuestion {
  return raw !== null && typeof raw === 'object' ? (raw as QuizQuestion) : {};
}

/** 把题卡填充进 host（返回归一化题目供点击判定用；含防御——
 * quizData 是外部数据，[null, 42, {...}] 形态不得让节点视图崩溃） */
function populateQuizContent(host: HTMLElement, dataJson: string): QuizQuestion[] {
  let raw: unknown[] = [];
  try {
    const parsed = JSON.parse(dataJson);
    if (Array.isArray(parsed)) raw = parsed;
  } catch {
    raw = [];
  }
  const questions = raw.map(normalizeQuestion);

  questions.forEach((question, qi) => {
    const card = document.createElement('div');
    card.className = 'quiz-card';
    card.dataset.index = String(qi);

    const head = document.createElement('div');
    head.className = 'quiz-head';
    const badge = document.createElement('span');
    badge.className = 'quiz-badge';
    badge.textContent = `Q${qi + 1}`;
    const title = document.createElement('span');
    title.className = 'quiz-question';
    title.textContent = String(question.question ?? '');
    head.append(badge, title);
    card.appendChild(head);

    const options = Array.isArray(question.options) ? question.options : [];
    options.forEach((option, oi) => {
      const o: QuizOption =
        option !== null && typeof option === 'object' ? (option as QuizOption) : {};
      const el = document.createElement('div');
      el.className = 'quiz-option';
      el.setAttribute('role', 'radio');
      // tabindex=-1 而非 button：可聚焦元素会干扰 Ctrl+End 的光标定位，
      // 让原子节点外的 caret 落到卡片内部（输入即整卡被替换删掉）。
      el.tabIndex = -1;
      el.dataset.index = String(oi);
      const circle = document.createElement('span');
      circle.className = 'quiz-circle';
      const label = document.createElement('span');
      label.className = 'quiz-option-label';
      label.textContent = String(o.label ?? ANSWER_LABELS[oi] ?? '?');
      const text = document.createElement('span');
      text.className = 'quiz-option-text';
      text.textContent = String(o.text ?? '');
      el.append(circle, label, text);
      card.appendChild(el);
    });

    // 解析说明：选中选项后显示（HTML 经公共净化器渲染）
    if (typeof question.explanation === 'string') {
      card.appendChild(buildExplanation(question.explanation));
    }

    host.appendChild(card);
  });

  return questions;
}

/** 构建卡片 DOM 静态镜像（导出 toDOM 用；编辑器视图见 QuizView.render） */
function buildQuizDom(dataJson: string): HTMLElement {
  const host = document.createElement('div');
  host.className = 'typewren-quiz';
  host.setAttribute('contenteditable', 'false');
  host.setAttribute('data-quiz', dataJson);
  populateQuizContent(host, dataJson);
  return host;
}

export const interactiveQuizView = $view(interactiveQuizSchema.node, () => {
  return (node) => new QuizView(node);
});
