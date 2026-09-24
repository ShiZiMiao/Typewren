import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView, NodeView } from '@milkdown/kit/prose/view';
import { $view } from '@milkdown/kit/utils';
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark';

import { lowlight } from './highlight';

/* ============================================================
 * 代码块语言角标（Typora 式）：
 * - 语言非空：右下角显示语言名；点击后**就地**变成输入框（角标位置），
 *   下方浮出语言列表（lowlight 注册的语言全集）——输入即过滤、
 *   点击/回车应用、回车清空、Esc/点击外部取消，全程无模态弹窗；
 * - 语言为空：内容稳定（防抖）后自动识别，识别成功**角标直接显示**
 *   识别语言（不写入文档——避免"打开即变脏"），点击即就地应用。
 * DOM 结构仍是 pre > code（contentDOM 不变），prosemirror-highlight
 * 的 inline decorations 原样工作；导出走 schema toDOM 序列化，
 * 与 NodeView 无关（导出 HTML 仍保留 data-language）。
 * ============================================================ */

/** 空语言的角标文案 */
const AUTO_LABEL = '自动';
/** 内容稳定后触发自动识别的防抖（输入中途不抖动、不反复重算） */
const AUTO_DETECT_DEBOUNCE_MS = 800;
/** lowlight 注册的语言全集（exclude plaintext，字母序） */
const LANGUAGES: string[] = lowlight
  .listLanguages()
  .filter((name) => name !== 'plaintext')
  .sort((a, b) => a.localeCompare(b, 'en'));

/**
 * 强特征启发式（优先于 highlightAuto）：highlight.js 的全局评分对
 * 短代码块不稳定（如 `import os` + `print("666")` 会判成 go），
 * 语言标志性写法出现时直接判定。
 */
function detectByPatterns(text: string): string {
  // python：import 语句 / print( / def 定义 / self. / python 环境标记
  if (
    /(^|\n)\s*(import\s+[a-z_][\w.]*|from\s+[\w.]+\s+import\s|print\s*\(|def\s+\w+\s*\(|class\s+\w+[:(]|self\.|env\s+python)/m.test(
      text
    )
  ) {
    return 'python';
  }
  // javascript / typescript：箭头函数 / const / function / console / node 环境标记
  if (
    /(=>|\b(const|let|var)\s+\w+\s*=|\bfunction\s+\w+\s*\(|console\.(log|warn|error)\s*\(|document\.|env\s+node)/.test(
      text
    )
  ) {
    return 'javascript';
  }
  // bash：shell 环境标记 / 常见包管理命令
  if (
    /(env\s+(ba)?sh|npm\s+(install|i|run)|git\s+(clone|status|commit|push)|pip\s+install|\becho\s+)/m.test(
      text
    )
  ) {
    return 'bash';
  }
  // json：对象开头带引号键
  if (/^\s*\{\s*"[\w-]+"\s*:/.test(text)) return 'json';
  // html
  if (/^\s*(<!doctype\s+html>|<html\b|<div\b|<body\b)/i.test(text)) return 'html';
  // css：选择器 { 属性: 开头
  if (/(^|\n)\s*[.#\w-]+\s*\{[^}]*[a-z-]+\s*:[^;]*;/i.test(text)) return 'css';
  // sql
  if (/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(text)) {
    return 'sql';
  }
  return '';
}

/** 自动识别代码块语言（强特征优先，highlight.js 评分兜底；无把握返回空串） */
export function detectCodeLanguage(code: string): string {
  const text = code.trim();
  if (text.length < 4) return '';
  const byPattern = detectByPatterns(text);
  if (byPattern) return byPattern;
  // 评分兜底只对中等长度的代码块：highlight.js 对短文本会给无差别低分猜测
  // （"hello, world!" 会判成 javascript），短块特征未命中宁可保持「自动」；
  // 超长块（>20k）同步评分会卡顿，且收益有限，也不兜底
  if (text.length < 200 || text.length > 20_000) return '';
  try {
    const result = lowlight.highlightAuto(text);
    const data = result.data;
    const language = data?.language ?? '';
    if (!language || language === 'plaintext' || (data?.relevance ?? 0) < 3) return '';
    return language;
  } catch {
    return '';
  }
}

class CodeBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private badge: HTMLButtonElement;
  private node: ProseNode;
  /** 自动识别防抖计时器与已识别的文本快照（内容未变时不重置计时） */
  private detectTimer: number | null = null;
  private lastCodeText = '';
  /** 当前文本已识别过且无结果：不重复预算（内容变化后重置） */
  private detectAttempted = false;
  /** 最近的识别结果（仅用于角标显示与弹窗预填，不写入文档） */
  private detectedLanguage = '';

  constructor(
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    node: ProseNode
  ) {
    this.node = node;

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    this.dom = pre;
    this.contentDOM = code;
    pre.appendChild(code);

    this.badge = document.createElement('button');
    this.badge.type = 'button';
    this.badge.className = 'code-lang-badge';
    // mousedown 拦截：防止点击角标把光标带进代码块/丢弃当前选区
    this.badge.addEventListener('mousedown', (e) => e.preventDefault());
    this.badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.promptLanguage();
    });

    pre.appendChild(this.badge);
    this.render();
    this.scheduleAutoDetect();
  }

  update(nextNode: ProseNode): boolean {
    if (nextNode.type.name !== 'code_block') return false;
    this.node = nextNode;
    this.render();
    this.scheduleAutoDetect();
    return true;
  }

  /**
   * badge 文本/标题与 data-language 属性变化是视图自身维护的：
   * 交还 PM 按"contentDOM 之外一律忽略"处理，否则 badge 更新会
   * 被 DOMObserver 当成外部修改触发整视图重建（update→detect→render 循环）。
   */
  ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: Node }): boolean {
    return !this.contentDOM.contains(mutation.target) && mutation.type !== 'selection';
  }

  destroy(): void {
    if (this.detectTimer !== null) window.clearTimeout(this.detectTimer);
    if (this.focusTimer !== null) window.clearTimeout(this.focusTimer);
    if (this.onDocMouseDown) document.removeEventListener('mousedown', this.onDocMouseDown, true);
    if (this.onViewportChange) {
      window.removeEventListener('scroll', this.onViewportChange, true);
      window.removeEventListener('resize', this.onViewportChange);
    }
    this.editorInput?.remove();
    this.floatList?.remove();
    this.dom.remove();
  }

  private render(): void {
    const language = (this.node.attrs.language as string) ?? '';
    if (language) {
      this.dom.setAttribute('data-language', language);
    } else {
      this.dom.removeAttribute('data-language');
    }
    // 显示优先级：已应用语言 > 自动识别结果 > 「自动」
    const shown = language || this.detectedLanguage;
    this.badge.textContent = shown || AUTO_LABEL;
    this.badge.title = shown
      ? shown === language
        ? `语言：${shown}（点击修改语言）`
        : `自动识别：${shown}（点击应用/修改）`
      : '自动识别语言（点击确认/修改）';
  }

  /** 空语言代码块：内容稳定后自动识别一次（仅展示，不写文档） */
  private scheduleAutoDetect(): void {
    if (((this.node.attrs.language as string) ?? '') !== '') return;
    const code = this.node.textContent ?? '';
    if (code !== this.lastCodeText) {
      this.lastCodeText = code;
      this.detectAttempted = false;
      this.detectedLanguage = '';
      // 内容已变化：作废挂起的旧检测（其闭包还引用旧文本），重新计时
      if (this.detectTimer !== null) {
        window.clearTimeout(this.detectTimer);
        this.detectTimer = null;
      }
      // 检测期间角标先显示「自动」，识别完成后再显示识别语言
      this.render();
    }
    if (this.detectAttempted || this.detectTimer !== null) return;
    this.detectTimer = window.setTimeout(() => {
      this.detectTimer = null;
      const detected = detectCodeLanguage(code);
      if (!detected || detected === 'mermaid') {
        // 无把握：角标回到「自动」，本次文本不再重试（内容变化后重新识别）
        this.detectAttempted = true;
        this.render();
        return;
      }
      // 防抖期内语言可能已被用户手动设置
      if (((this.node.attrs.language as string) ?? '') !== '') return;
      this.detectedLanguage = detected;
      this.render();
    }, AUTO_DETECT_DEBOUNCE_MS);
  }

  private promptLanguage(): void {
    const current = (this.node.attrs.language as string) ?? '';
    // 预填优先级：已应用语言 > 自动识别结果 > 现场检测兜底
    const defaultValue =
      current || this.detectedLanguage || detectCodeLanguage(this.node.textContent ?? '');
    this.openLanguageEditor(defaultValue);
  }

  /* ---------- 就地语言编辑器（输入框 + 浮层列表，无模态弹窗） ---------- */

  private editorInput: HTMLInputElement | null = null;
  private floatList: HTMLElement | null = null;
  private listNames: string[] = [];
  private listSelectedIndex = -1;
  private listUserTyped = false;
  private onDocMouseDown: ((e: MouseEvent) => void) | null = null;
  private onViewportChange: (() => void) | null = null;
  /** 挂起的就地编辑器聚焦定时器（close/destroy 时清理） */
  private focusTimer: number | null = null;

  private openLanguageEditor(defaultValue: string): void {
    if (this.editorInput) return;
    this.editorInput = document.createElement('input');
    const input = this.editorInput;
    input.id = 'language-editor';
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = '选择语言';
    input.className = 'code-lang-editor';
    input.value = defaultValue;
    this.badge.style.display = 'none';
    this.dom.appendChild(input);

    this.floatList = document.createElement('div');
    const list = this.floatList;
    list.className = 'language-dropdown';
    list.id = 'language-dropdown';
    document.body.appendChild(list);

    const positionList = (): void => {
      // 浮层 fixed 相对视口：滚动/缩放时按输入框当前 rect 重定位
      const rect = input.getBoundingClientRect();
      list.style.left = `${rect.left}px`;
      list.style.top = `${rect.bottom + 3}px`;
      list.style.width = `${rect.width}px`;
    };
    positionList();
    this.renderList(input.value);

    // 浮层须在 pre（overflow-x:auto）之外，避免被裁剪；
    // 容器滚动（capture 可见全部）或窗口变化时跟随输入框重定位
    this.onViewportChange = positionList;
    window.addEventListener('scroll', this.onViewportChange, true);
    window.addEventListener('resize', this.onViewportChange);
    input.addEventListener('input', () => {
      this.listUserTyped = true;
      this.renderList(input.value);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        // 输入为空回车 = 清除语言；否则应用选中/键入值
        const value =
          input.value.trim() === '' ? '' : (this.listNames[this.listSelectedIndex] ?? input.value);
        this.applyLanguage(value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeLanguageEditor();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.moveSelection(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.moveSelection(-1);
      }
    });
    this.onDocMouseDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (list.contains(t) || input.contains(t)) return;
      this.closeLanguageEditor();
    };
    document.addEventListener('mousedown', this.onDocMouseDown, true);

    // setTimeout 而非 rAF：无头/后台窗口 rAF 可能被节流，焦点必须随即生效；
    // 句柄留存供 closeLanguageEditor/destroy 清理（挂起的聚焦不得在收起后触发）
    this.focusTimer = window.setTimeout(() => {
      this.focusTimer = null;
      input.focus();
      input.select();
    }, 0);
  }

  private applyLanguage(value: string): void {
    this.closeLanguageEditor();
    this.setLanguage(value);
  }

  private closeLanguageEditor(): void {
    if (this.focusTimer !== null) {
      window.clearTimeout(this.focusTimer);
      this.focusTimer = null;
    }
    if (this.onDocMouseDown) document.removeEventListener('mousedown', this.onDocMouseDown, true);
    this.onDocMouseDown = null;
    if (this.onViewportChange) {
      window.removeEventListener('scroll', this.onViewportChange, true);
      window.removeEventListener('resize', this.onViewportChange);
      this.onViewportChange = null;
    }
    this.editorInput?.remove();
    this.editorInput = null;
    this.floatList?.remove();
    this.floatList = null;
    this.badge.style.display = '';
    this.view.focus();
  }

  private moveSelection(delta: number): void {
    if (this.listNames.length === 0) return;
    this.listSelectedIndex =
      (this.listSelectedIndex + delta + this.listNames.length) % this.listNames.length;
    this.highlightList();
  }

  /** 重绘浮层列表：过滤 + 选中高亮 + 滚动到选中项 */
  private renderList(queryRaw: string): void {
    const list = this.floatList;
    if (!list) return;
    const query = this.listUserTyped ? queryRaw.trim().toLowerCase() : '';
    let names = LANGUAGES.filter((name) => !query || name.toLowerCase().includes(query));
    // 当前输入（含自定义语言 id）不在列表时，置于最前
    if (query && !names.some((name) => name.toLowerCase() === query)) {
      names = [queryRaw.trim(), ...names];
    }
    this.listNames = names;
    if (names.length === 0) {
      list.innerHTML = '<div class="language-empty">无匹配语言</div>';
      this.listSelectedIndex = -1;
      return;
    }
    const prefill = this.editorInput?.value ?? '';
    const matchIndex = names.findIndex((name) => name.toLowerCase() === prefill.toLowerCase());
    this.listSelectedIndex = matchIndex >= 0 ? matchIndex : 0;

    list.innerHTML = '';
    names.forEach((name, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'language-item';
      item.dataset.language = name;
      item.textContent = name;
      if (index === this.listSelectedIndex) item.classList.add('selected');
      item.addEventListener('mouseenter', () => {
        this.listSelectedIndex = index;
        this.highlightList();
      });
      item.addEventListener('click', () => this.applyLanguage(name));
      list.appendChild(item);
    });
    const selected = list.querySelector<HTMLElement>('.language-item.selected');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }

  private highlightList(): void {
    this.floatList?.querySelectorAll('.language-item').forEach((el, index) => {
      el.classList.toggle('selected', index === this.listSelectedIndex);
    });
  }

  private setLanguage(language: string): void {
    if (language === ((this.node.attrs.language as string) ?? '')) return;
    const pos = this.getPos();
    if (pos === undefined) return;
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, {
      ...this.node.attrs,
      language
    });
    this.view.dispatch(tr);
  }
}

export const codeBlockLanguageView = $view(codeBlockSchema.node, () => {
  return (node, view, getPos) => new CodeBlockView(view, getPos, node);
});
