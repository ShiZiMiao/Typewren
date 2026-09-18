import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx } from '@milkdown/kit/core';
import type { EditorView } from '@milkdown/kit/prose/view';
import { TextSelection } from '@milkdown/kit/prose/state';

/* ============================================================
 * 成对符号补全（Typora 式）：
 * - 有选区：输入 `*`/`**`/`` ` ``/`~`/`$`/`[`/`(` 时包裹选区；
 * - 无选区：行首/行尾（两侧安全）时插入开+关符号并把光标放中间；
 * - 光标紧邻一个"疑似刚才自动补的关符号"时，再输入该符号 = 跳过（光标越过）。
 * 全程用 PM 事务 dispatch，不注入 input rules（避免与强调/斜体规则打架），
 * 也不走原生 beforeinput 默认路径（默认路径会触发 input rules）。
 * beforeinput 必须用捕获阶段注册：PM 的 handler 早于此控制器的监听
 * （编辑器创建时注册），普通阶段 preventDefault 就晚了。
 * 状态持久化，build 后由主装配 setup。
 * ============================================================ */

const PAIR_CANDIDATES = new Set(['*', '_', '`', '~', '$', '[', '(', ')', ']']);
const PAIRS: Record<string, string> = {
  '*': '*',
  _: '_',
  '`': '`',
  '~': '~',
  $: '$',
  '[': ']',
  '(': ')'
};
/** 闭合符（输入时若右邻是自身 → 越过不插入） */
const CLOSERS = new Set([')', ']']);
/** 开=闭同字符对：连续输入两次（`**`）应保持成对并让光标越过，而非插成 `***` */
const SAME_CHAR_PAIRS = new Set(['*', '_', '`', '~', '$']);

const ENABLE_KEY = 'typewren.auto-pairs';

/** 空串 = 文档边界（空文档/行首行尾），视为安全 */
function isSafeToOpen(prev: string | undefined, next: string | undefined): boolean {
  const safe = (ch: string | undefined): boolean =>
    ch === undefined || ch === '' || /\s|[\n\r]/.test(ch);
  return safe(prev) && safe(next);
}

export class AutoPairsController {
  private enabled = localStorage.getItem(ENABLE_KEY) !== '0';

  constructor(private readonly editor: Editor) {
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      // 捕获阶段注册：必须先于 ProseMirror 的 beforeinput 处理
      view.dom.addEventListener('beforeinput', this.handleBeforeInput, true);
    });
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    localStorage.setItem(ENABLE_KEY, this.enabled ? '1' : '0');
    return this.enabled;
  }

  private handleBeforeInput = (event: InputEvent): void => {
    if (!this.enabled) return;
    if (event.inputType !== 'insertText') return;
    const data = event.data;
    if (!data || data.length !== 1) return;
    const ch = data[0];
    if (!PAIR_CANDIDATES.has(ch)) return;

    const view = this.editor.action((ctx) => ctx.get(editorViewCtx));
    const { state } = view;
    const { from, to } = state.selection;

    // 1) 有选区：包裹
    if (from !== to) {
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
    // 2b) 同字符对（`*`/`` ` ``/`$` 等）连输第二个：如 `**` 开加粗——
    // 跳过插入并让光标越过自动补的关符号（插默认会得 `***`，破坏后续强调规则）
    if (SAME_CHAR_PAIRS.has(ch) && prevChar === ch && nextChar === ch) {
      event.preventDefault();
      const tr = state.tr.setSelection(TextSelection.create(state.doc, to + 1));
      view.dispatch(tr);
      return;
    }

    // 3) 光标前后安全（行首/空格/行尾）→ 插入开+关并把光标放中间
    if (prevChar !== ch && isSafeToOpen(prevChar || undefined, nextChar || undefined)) {
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

export function createAutoPairs(editor: Editor): AutoPairsController {
  return new AutoPairsController(editor);
}
