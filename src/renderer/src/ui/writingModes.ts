import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx } from '@milkdown/kit/core';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorState } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

import { localStore } from '../util/storage';
import { screenPxToLocal } from './zoom';

/* ============================================================
 * 写作模式：焦点模式（当前块高亮，其余淡化）+ 打字机模式
 * （光标始终保持在编辑区中部，输入时自动滚动）
 * - 状态持久化（localStorage），窗口内生效；
 * - 焦点模式：用 PM decorations 标注光标所在块（随视图重建自动恢复，
 *   直接改 DOM class 会被 PM 更新覆盖）；
 * - 打字机模式：选区/滚动变化时把光标行滚到编辑区中部。
 * ============================================================ */

const FOCUS_KEY = 'typewren.focus-mode';
const TYPEWRITER_KEY = 'typewren.typewriter-mode';
/** 打字机模式光标准线（相对容器高度的中点比例） */
const TYPEWRITER_CENTER_RATIO = 0.5;

/** 光标所在块的锚点区间（decoration 用；before/after 为含起不含止的标准节点边界）。
 * 焦点块 = 光标祖先链中**最上层的块节点**：淡化规则作用于顶层子块
 * （.focus-mode > *），若只取内层 textblock（引用块里的段落、列表里的项、
 * 单元格里的段落），外层容器会被整体淡化、当前块反而不突出——因此
 * 引用块取整块引用、列表取整条列表、表格取整表、普通段落取段落本身。 */
function focusedBlockRange(state: EditorState): { from: number; to: number } | null {
  const $from = state.selection.$from;
  let topDepth: number | null = null;
  for (let d = $from.depth; d >= 1; d--) {
    if ($from.node(d).isBlock) topDepth = d;
  }
  if (topDepth === null) return null;
  return { from: $from.before(topDepth), to: $from.after(topDepth) };
}

const focusDecoKey = new PluginKey<DecorationSet>('typewrenFocusDeco');

export class WritingModes {
  private focusOn = localStore.get(FOCUS_KEY) === '1';
  private typewriterOn = localStore.get(TYPEWRITER_KEY) === '1';

  constructor(private readonly editor: Editor) {
    // 应用持久化状态（首帧）
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dom.classList.toggle('focus-mode', this.focusOn);
      view.dom.classList.toggle('typewriter-mode', this.typewriterOn);
    });
  }

  get isFocus(): boolean {
    return this.focusOn;
  }

  get isTypewriter(): boolean {
    return this.typewriterOn;
  }

  toggleFocus(): boolean {
    this.focusOn = !this.focusOn;
    localStore.set(FOCUS_KEY, this.focusOn ? '1' : '0');
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dom.classList.toggle('focus-mode', this.focusOn);
      // decorations 在事务 apply 时重建：空事务触发选区插件重算
      view.dispatch(view.state.tr.setMeta('writingModes:refresh', true));
    });
    return this.focusOn;
  }

  toggleTypewriter(): boolean {
    this.typewriterOn = !this.typewriterOn;
    localStore.set(TYPEWRITER_KEY, this.typewriterOn ? '1' : '0');
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dom.classList.toggle('typewriter-mode', this.typewriterOn);
      this.scrollToCenter(view);
    });
    return this.typewriterOn;
  }

  /** 打字机滚动：把光标行滚到编辑区垂直中部 */
  scrollToCenter(view: EditorView): void {
    if (!this.typewriterOn) return;
    const container = this.containerOf(view);
    if (!container) return;
    const coords = view.coordsAtPos(view.state.selection.from);
    const rect = container.getBoundingClientRect();
    // coords/rect 差值是屏幕像素（zoom 子树内 ×zoom），scrollTop 是局部单位——
    // ÷zoom 换算再相加（zoom≠100% 时旧公式落点偏移 zoom 倍）；
    // 容器高度用 clientHeight（局部单位），光标目标 = 内容中部
    const target =
      container.scrollTop +
      screenPxToLocal(container, coords.top - rect.top) -
      container.clientHeight * TYPEWRITER_CENTER_RATIO;
    container.scrollTop = Math.max(0, target);
  }

  /** 编辑区滚动监听（用户滚动后防回弹：仅打字模式启用且轻微迟钝） */
  attach(view: EditorView): void {
    const container = this.containerOf(view);
    if (!container) return;
    let timer: number | null = null;
    container.addEventListener(
      'scroll',
      () => {
        if (!this.typewriterOn) return;
        if (timer !== null) clearTimeout(timer);
        timer = window.setTimeout(() => this.scrollToCenter(view), 120);
      },
      { passive: true }
    );
  }

  private containerOf(view: EditorView): HTMLElement | null {
    return view.dom.closest('#editor-container');
  }
}

/** PM 插件：焦点块装饰 + 打字机居中 */
export function writingPlugin(modes: () => WritingModesLike) {
  return $prose(() => {
    return new Plugin({
      key: focusDecoKey,
      state: {
        init: (_cfg, state): DecorationSet => {
          void _cfg;
          return buildDecorations(state, modes().isFocus);
        },
        apply: (tr, set) => {
          if (!tr.docChanged && !tr.selectionSet && !tr.getMeta('writingModes:refresh')) {
            return set.map(tr.mapping, tr.doc);
          }
          // tr.selection 恒为事务后的 selection（含未修改时的克隆）
          const next = rebuildDecorations(tr.doc, modes().isFocus, tr.selection);
          return next;
        }
      },
      props: {
        decorations(state) {
          const set = focusDecoKey.getState(state) ?? DecorationSet.empty;
          return set;
        }
      },
      view(view: EditorView) {
        modes().attach(view);
        return {
          update: (v: EditorView, prev: EditorView['state']) => {
            // 模式类必须每次更新都同步：PM 的 attributes（editorViewOptionsCtx）
            // 会在 docView 更新时重写 view.dom，任何时序/插件差异都可能把
            // focus-mode/typewriter-mode 抹掉（仅 toggle 时加类并不可靠）。
            v.dom.classList.toggle('focus-mode', modes().isFocus);
            v.dom.classList.toggle('typewriter-mode', modes().isTypewriter);
            if (modes().isTypewriter && !prev.selection.eq(v.state.selection)) {
              modes().scrollToCenter(v);
            }
          }
        };
      }
    });
  });
}

function buildDecorations(state: EditorState, focusOn: boolean): DecorationSet {
  if (!focusOn) return DecorationSet.empty;
  const range = focusedBlockRange(state);
  if (!range) return DecorationSet.empty;
  return DecorationSet.create(state.doc, [
    Decoration.node(range.from, range.to, { class: 'focused-block' })
  ]);
}

function rebuildDecorations(
  doc: EditorState['doc'],
  focusOn: boolean,
  selection: EditorState['selection'] | null
): DecorationSet {
  if (!focusOn || !selection) return DecorationSet.empty;
  const $from = selection.$from;
  if (!$from) return DecorationSet.empty;
  const range = focusedBlockRange({ doc, selection } as EditorState);
  if (!range) return DecorationSet.empty;
  try {
    const set = DecorationSet.create(doc, [
      Decoration.node(range.from, range.to, { class: 'focused-block' })
    ]);
    return set;
  } catch {
    return DecorationSet.empty;
  }
}

/** 视图顶部按钮/命令联动入口（返回当前状态供 UI 文案使用） */
export function createWritingModes(editor: Editor): WritingModes {
  return new WritingModes(editor);
}

/** 插件所需子集（晚绑定槽允许空实现） */
export type WritingModesLike = Pick<
  WritingModes,
  'isFocus' | 'isTypewriter' | 'scrollToCenter' | 'attach'
>;
