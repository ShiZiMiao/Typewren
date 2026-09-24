import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx } from '@milkdown/kit/core';
import type { EditorView } from '@milkdown/kit/prose/view';
import { TextSelection, type EditorState } from '@milkdown/kit/prose/state';

/* ============================================================
 * 成对符号补全（Typora / IDE 式）：
 * - 有选区：输入 `*`/`**`/`` ` ``/`~`/`$`/`[`/`(` 时包裹选区；
 * - 正文：行首/行尾（两侧安全）时插入开+关符号并把光标放中间；
 * - 代码块内：( [ " 不受两侧安全限制自动成对（IDE 行为，代码里
 *   紧邻字符也常见），* _ ` ~ $ 等 Markdown 标记维持不补；
 * - 行内代码（inlineCode mark）内不补全（短代码片段原样输入）；
 * - 光标紧邻一个"疑似刚才自动补的关符号"时，再输入该符号 = 跳过（光标越过）。
 * 全程用 PM 事务 dispatch，不注入 input rules（避免与强调/斜体规则打架），
 * 也不走原生 beforeinput 默认路径（默认路径会触发 input rules）。
 * beforeinput 必须用捕获阶段注册：PM 的 handler 早于此控制器的监听
 * （编辑器创建时注册），普通阶段 preventDefault 就晚了。
 * 状态持久化，build 后由主装配 setup。
 * ============================================================ */

const PAIR_CANDIDATES = new Set(['*', '_', '`', '~', '$', '[', '(', ')', ']']);
/** 代码块内补全集（IDE 式：( [ "；* _ ` ~ $ 是 Markdown 标记维持不补；
 * ) ] 保留用于"跳过自动补的关符号"判定） */
const CODE_PAIR_CANDIDATES = new Set(['[', '(', ')', ']', '"']);
const PAIRS: Record<string, string> = {
  '*': '*',
  _: '_',
  '`': '`',
  '~': '~',
  $: '$',
  '[': ']',
  '(': ')',
  '"': '"'
};
/** 闭合符（输入时若右邻是自身 → 越过不插入） */
const CLOSERS = new Set([')', ']']);
/** 开=闭同字符对：连续输入两次（`**`）应保持成对并让光标越过，而非插成 `***` */
const SAME_CHAR_PAIRS = new Set(['*', '_', '`', '~', '$', '"']);

const ENABLE_KEY = 'typewren.auto-pairs';

/** 空串 = 文档边界（空文档/行首行尾），视为安全 */
function isSafeToOpen(prev: string | undefined, next: string | undefined): boolean {
  const safe = (ch: string | undefined): boolean =>
    ch === undefined || ch === '' || /\s|[\n\r]/.test(ch);
  return safe(prev) && safe(next);
}

/**
 * 选区是否可安全"压平包裹"：同一 textblock 内且不含非文本行内节点。
 * wrapSelection 用 textBetween 把选区压成纯文本再整段替换——选区里若有
 * 图片/行内公式/硬换行等原子节点会被直接销毁；跨段落则替换会拆结构。
 * 不满足时放弃补全（交回默认输入），不猜测包裹结果。
 */
function canWrapSelection(state: EditorState): boolean {
  const { from, to, $from, $to } = state.selection;
  if ($from.depth === 0 || !$from.sameParent($to)) return false;
  let pureText = true;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isInline && !node.isText) pureText = false;
  });
  return pureText;
}

export class AutoPairsController {
  private enabled: boolean;
  /** beforeinput 监听的卸载句柄（捕获阶段注册，dispose 时成对摘除） */
  private readonly abort = new AbortController();

  constructor(
    private readonly editor: Editor,
    initial: boolean
  ) {
    const stored = localStorage.getItem(ENABLE_KEY);
    // localStorage 镜像优先（旧版遗留/测试预置），settings.json 为权威
    this.enabled = stored !== null ? stored !== '0' : initial;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      // 捕获阶段注册：必须先于 ProseMirror 的 beforeinput 处理
      view.dom.addEventListener('beforeinput', this.handleBeforeInput, {
        capture: true,
        signal: this.abort.signal
      });
    });
  }

  /** 清理事件监听（编辑器销毁/重建时由装配方调用） */
  dispose(): void {
    this.abort.abort();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  toggle(): void {
    this.onToggle(!this.enabled);
  }

  /** 设置存储应用点：同步状态与镜像缓存（供 reload 预置） */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    localStorage.setItem(ENABLE_KEY, enabled ? '1' : '0');
  }

  /** 供主装配注入：把开关变更写回设置存储（onToggle 参数为下一状态） */
  onToggle: (next: boolean) => void = () => {};

  /** 光标是否位于代码块（code_block 节点祖先链内） */
  private isInCodeBlock(state: EditorState): boolean {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === 'code_block') return true;
    }
    return false;
  }

  /** 光标是否位于行内代码（inlineCode mark 内）：不补全 */
  private isInInlineCode(state: EditorState): boolean {
    return state.selection.$from.marks().some((m) => m.type.name === 'inlineCode');
  }

  private handleBeforeInput = (event: InputEvent): void => {
    if (!this.enabled) return;
    if (event.inputType !== 'insertText') return;
    const data = event.data;
    if (!data || data.length !== 1) return;
    const ch = data[0];

    const view = this.editor.action((ctx) => ctx.get(editorViewCtx));
    const { state } = view;

    // 行内代码原样输入（短文本内自动成对反而添乱）
    if (this.isInInlineCode(state)) return;
    const inCodeBlock = this.isInCodeBlock(state);
    const candidates = inCodeBlock ? CODE_PAIR_CANDIDATES : PAIR_CANDIDATES;
    if (!candidates.has(ch)) return;

    const { from, to } = state.selection;

    // 1) 有选区：包裹（仅同段落纯文本选区；含原子节点时放弃补全，
    // 防 textBetween 压平重建把图片/公式销毁——见 canWrapSelection）
    if (from !== to) {
      if (!canWrapSelection(state)) return;
      event.preventDefault();
      this.wrapSelection(view, ch);
      return;
    }

    // 2) 输入闭合符且右邻正是它（自动补的关符号）→ 跳过：光标越过
    const prevChar = state.doc.textBetween(Math.max(0, from - 1), from, ' ');
    const nextChar = state.doc.textBetween(to, to + 1, ' ');
    if (CLOSERS.has(ch) && nextChar === ch) {
      event.preventDefault();
      const tr = state.tr.setSelection(TextSelection.create(state.doc, to + 1));
      view.dispatch(tr);
      return;
    }
    // 2b) 同字符对（`*`/`` ` ``/`$`/`"` 等）连输第二个：如 `**` 开加粗、
    // 引号跳过自动补的关符号（插默认会得重影）
    if (SAME_CHAR_PAIRS.has(ch) && prevChar === ch && nextChar === ch) {
      event.preventDefault();
      const tr = state.tr.setSelection(TextSelection.create(state.doc, to + 1));
      view.dispatch(tr);
      return;
    }

    // 3) 插入开+关并把光标放中间：正文要求两侧安全（行首/空格/行尾），
    // 代码块内不受此限（IDE 行为，`print(` 这类紧邻位置也补全）
    if (
      prevChar !== ch &&
      (inCodeBlock || isSafeToOpen(prevChar || undefined, nextChar || undefined))
    ) {
      event.preventDefault();
      this.insertPair(view, ch);
      return;
    }
  };

  private wrapSelection(view: EditorView, ch: string): void {
    const { state } = view;
    const { from, to } = state.selection;
    const closer = PAIRS[ch];
    const text = state.doc.textBetween(from, to, '');
    const node = state.schema.text(ch + text + closer);
    if (!node) return;
    const tr = state.tr.replaceSelectionWith(node);
    const sel = TextSelection.create(tr.doc, from + 1);
    view.dispatch(tr.setSelection(sel));
  }

  private insertPair(view: EditorView, ch: string): void {
    const { state } = view;
    const { from } = state.selection;
    const closer = PAIRS[ch];
    const tr = state.tr.insertText(ch + closer, from);
    // 选区必须基于事务后的 doc（旧 doc 的位置在插入后不再有效）
    tr.setSelection(TextSelection.create(tr.doc, from + 1));
    view.dispatch(tr);
  }
}

export function createAutoPairs(editor: Editor, initial: boolean): AutoPairsController {
  return new AutoPairsController(editor, initial);
}
