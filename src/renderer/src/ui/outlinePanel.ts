import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/kit/prose/state';

import { setSourceCaret, sourceLines, stripMarkup } from './positionSync';
import { screenPxToLocal } from './zoom';

/** 滚动联动阈值：标题行顶距视口顶 8px 内视为“位于顶部” */
const SCROLL_ACTIVE_THRESHOLD_PX = 8;
/** 大纲跳转平滑滚动兜底：scrollend 未触发时的最大等待（选段落回时长） */
const SCROLL_ANIMATION_TIMEOUT_MS = 800;
/** 源码模式"视口顶行"取样的 x 偏移：文本起点在 56px 左 padding 之后
 * （layout.css #source-textarea 的 padding-left），+60 保证命中正文行
 * 而非 padding 空白（caretRangeFromPoint 落空时返回 null 直接放弃联动） */
const SOURCE_LINE_HIT_X_PX = 60;

export interface OutlineEntry {
  level: number;
  text: string;
  /** 标题在文档中的序号（用于点击时重新定位） */
  index: number;
}

export interface OutlinePanelDeps {
  /** 当前是否处于源码模式（决定跳转目标：渲染视图 / 源码文本行） */
  isSourceMode(): boolean;
  /** 源码编辑区元素（源码模式跳转用） */
  sourceEl(): HTMLElement | null;
}

/** 从当前文档收集全部标题（含位置信息） */
function collectHeadings(editor: Editor): (OutlineEntry & { pos: number })[] {
  const entries: (OutlineEntry & { pos: number })[] = [];

  editor.action((ctx) => {
    const doc = ctx.get(editorViewCtx).state.doc;

    doc.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        entries.push({
          level: Number(node.attrs.level),
          // 空标题保持空串（显示兜底见 outlineLabel）：兜底文案 '标题 N'
          // 永不等于源码行的空内容，曾让空标题的源码跳转匹配静默失败
          text: node.textContent.trim(),
          pos,
          index: entries.length
        });
      }
      return true;
    });
  });

  return entries;
}

/** 大纲项显示文本（空标题兜底序号；匹配口径仍是 entry.text，勿混用） */
function outlineLabel(entry: OutlineEntry): string {
  return entry.text || `标题 ${entry.index + 1}`;
}

/** ATX 标题行：^ {0,3}#{1,6} 后跟空白 */
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
/** Setext 下划线行（= → h1，- → h2） */
const SETEXT_RE = /^ {0,3}(=+|-+)\s*$/;

/** 从 fromLine 起匹配单个标题（level + 文本），返回行号与光标落点 */
function matchHeadingInLines(
  lines: { start: number; content: string }[],
  level: number,
  headingText: string,
  fromLine: number
): { line: number; caret: number } | null {
  for (let i = fromLine; i < lines.length; i++) {
    // ATX：# 120
    const atx = ATX_RE.exec(lines[i].content);
    if (atx && atx[1].length === level && stripMarkup(atx[2] ?? '') === headingText) {
      const content = atx[2] ?? '';
      const caret = lines[i].start + atx[0].length - content.length;
      return { line: i, caret };
    }

    // Setext：本行为标题文本，下一行为 = / - 下划线
    const underline = SETEXT_RE.exec(lines[i + 1]?.content ?? '');
    if (underline) {
      const isH1 = underline[1][0] === '=';
      if ((isH1 && level === 1) || (!isH1 && level === 2)) {
        if (stripMarkup(lines[i].content) === headingText) {
          return { line: i, caret: lines[i].start };
        }
      }
    }
  }
  return null;
}

/** 在源码文本中按文档顺序定位第 index 个标题的光标落点（找不到返回 null） */
function findSourceHeadingCaret(
  text: string,
  entries: OutlineEntry[],
  index: number
): number | null {
  const lines = sourceLines(text);
  let lineCursor = 0;
  for (let i = 0; i <= index; i++) {
    const entry = entries[i];
    if (!entry) return null;
    const found = matchHeadingInLines(lines, entry.level, entry.text, lineCursor);
    if (found === null) {
      // 顺序失配（源码被编辑过标题）时仅对目标项做一次全量兜底
      if (i === index) {
        const retry = matchHeadingInLines(lines, entry.level, entry.text, 0);
        return retry ? retry.caret : null;
      }
      return null;
    }
    lineCursor = found.line + 1;
    if (i === index) return found.caret;
  }
  return null;
}

/**
 * 源码模式跳转：先滚动标题行到视口顶部、滚动完成后定位光标。
 * 与渲染模式完全同序（先滚后设光标）避免"闪一下再移动"；
 * onDone 在滚动结束（或已到位）后回调——由调用方解锁高亮。
 * 返回是否成功落点（失败时调用方保持原状）。
 */
function jumpInSource(
  el: HTMLElement,
  entries: OutlineEntry[],
  index: number,
  onDone?: () => void
): boolean {
  const text = el.textContent ?? '';
  const caret = findSourceHeadingCaret(text, entries, index);
  if (caret === null) return false;

  // 先设光标（用于计算滚动目标），再滚动到目标；滚动完重新确认光标位置
  if (!setSourceCaret(el, caret)) return false;

  const selection = window.getSelection();
  const rect =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0).getBoundingClientRect() : null;
  const containerRect = el.getBoundingClientRect();
  // rect 差值是屏幕像素，scrollTop 是局部单位（zoom≠100% 相差 zoom 倍）——
  // 换算见 screenPxToLocal
  const scrollTarget =
    rect && containerRect.height > 0 && rect.height > 0
      ? Math.max(0, el.scrollTop + screenPxToLocal(el, rect.top - containerRect.top))
      : -1;

  // 标题行对齐视口顶部 + 平滑滚动（与渲染模式 jumpTo 行为一致）
  const finish = (): void => {
    // 滚动结束后重新精确落光标（滚动不改变偏移，覆盖偶发布局变化）
    setSourceCaret(el, caret);
    onDone?.();
  };

  if (scrollTarget >= 0 && el.scrollTop !== scrollTarget) {
    let finished = false;
    const done = (): void => {
      if (finished) return;
      finished = true;
      finish();
    };
    el.addEventListener('scrollend', done, { once: true });
    window.setTimeout(done, SCROLL_ANIMATION_TIMEOUT_MS);
    el.scrollTo({ top: scrollTarget, behavior: 'smooth' });
  } else {
    finish();
  }
  return true;
}

export interface OutlineController {
  refresh(): void;
  setActive(index: number | null): void;
  jumpTo(index: number): void;
  /** 源码模式光标偏移 → 大纲 active 高亮联动 */
  updateActiveFromSource(text: string, caretOffset: number): void;
  /** 滚动联动：视口顶部附近的标题决定 active（渲染/源码模式都适用） */
  updateActiveFromScroll(): void;
}

export function createOutlinePanel(
  editor: Editor,
  treeEl: HTMLElement,
  deps: OutlinePanelDeps
): OutlineController {
  let entries: (OutlineEntry & { pos: number })[] = [];
  let buttons: HTMLButtonElement[] = [];

  function rebuildDom(): void {
    treeEl.innerHTML = '';
    buttons = [];

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'outline-empty';
      empty.textContent = '暂无标题，使用 # 创建';
      treeEl.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'outline-item';
      // 点击闭包只捕获 index（= 按钮位置，稳定）；文案/级别随 refresh 原地更新
      btn.addEventListener('click', () => controller.jumpTo(entry.index));
      applyButtonContent(btn, entry);
      treeEl.appendChild(btn);
      buttons.push(btn);
    }
  }

  /** 按钮内容与条目同步（标题改字/改级时复用按钮，不整树重建） */
  function applyButtonContent(btn: HTMLButtonElement, entry: OutlineEntry): void {
    const label = outlineLabel(entry);
    btn.dataset.level = String(entry.level);
    btn.title = label;
    btn.textContent = label;
  }

  const controller: OutlineController = {
    refresh(): void {
      entries = collectHeadings(editor);

      // 数量不变 → 原地更新文案/级别：任一标题变化就 rebuildDom 全量重建
      // 会丢滚动位置且闪烁；按钮引用与点击闭包（只用 index）都可复用
      if (buttons.length === entries.length) {
        entries.forEach((entry, i) => applyButtonContent(buttons[i], entry));
        return;
      }
      rebuildDom();
    },

    setActive(index: number | null): void {
      buttons.forEach((btn, i) => {
        btn.classList.toggle('active', i === index);
        if (i === index) {
          btn.scrollIntoView({ block: 'nearest' });
        }
      });
    },

    /**
     * 源码模式下按光标偏移同步 outline active：
     * 顺序匹配各标题源码行，光标落在哪个标题行（含其上方到下一标题之间）就高亮谁。
     */
    updateActiveFromSource(text: string, caretOffset: number): void {
      if (!deps.isSourceMode() || entries.length === 0) return;
      const lines = sourceLines(text);
      let active: number | null = null;
      let lineCursor = 0;
      for (let i = 0; i < entries.length; i++) {
        const found = matchHeadingInLines(lines, entries[i].level, entries[i].text, lineCursor);
        if (!found) break; // 顺序失配：不再向下匹配（避免误判）
        lineCursor = found.line + 1;
        if (caretOffset >= lines[found.line].start) {
          active = i;
        } else {
          break; // 光标在该标题行上方 → 保持已确认的前一项
        }
      }
      controller.setActive(active);
    },

    /**
     * 滚动联动：视口顶部附近的标题决定 outline active。
     * 渲染模式按标题 DOM 矩形判定；源码模式把「视口顶行」换算为文本偏移
     * 后复用 updateActiveFromSource 的标题行匹配。
     */
    updateActiveFromScroll(): void {
      if (deps.isSourceMode()) {
        const el = deps.sourceEl();
        if (!el || entries.length === 0) return;
        const containerRect = el.getBoundingClientRect();
        if (containerRect.height === 0) return;
        // 滚到底：末尾标题可能因内容不足无法到达视口顶部，直接高亮最后一项
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
          controller.setActive(entries.length - 1);
          return;
        }
        // 文本起点在左 padding 之后（见 SOURCE_LINE_HIT_X_PX 注释）
        const range = document.caretRangeFromPoint(
          containerRect.left + SOURCE_LINE_HIT_X_PX,
          containerRect.top + SCROLL_ACTIVE_THRESHOLD_PX
        );
        if (!range) return;
        const pre = document.createRange();
        pre.selectNodeContents(el);
        pre.setEnd(range.startContainer, range.startOffset);
        controller.updateActiveFromSource(el.textContent ?? '', pre.toString().length);
        return;
      }

      const container = document.querySelector('#editor-container');
      const pm = document.querySelector('.ProseMirror');
      if (!container || !pm || entries.length === 0) return;
      // 每帧一次 querySelectorAll（旧实现 count 与列表各查一次，scroll 高频路径白费一倍遍历）
      const headings = pm.querySelectorAll('h1, h2, h3, h4, h5, h6');
      const count = Math.min(headings.length, entries.length);
      // 滚到底：末尾标题可能因内容不足无法到达视口顶部，直接高亮最后一项
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 1) {
        if (count > 0) controller.setActive(count - 1);
        return;
      }
      const containerTop = container.getBoundingClientRect().top;
      let active: number | null = null;
      for (let i = 0; i < count; i++) {
        const top = (headings[i] as HTMLElement).getBoundingClientRect().top;
        if (top <= containerTop + SCROLL_ACTIVE_THRESHOLD_PX) {
          active = i; // 最后一个滚过/触及顶部的标题
        } else {
          break;
        }
      }
      // 未滚到任何标题（视口顶部在第一个标题上方）时高亮第一项
      controller.setActive(active ?? (count > 0 ? 0 : null));
    },

    jumpTo(index: number): void {
      const target = entries[index];
      if (!target) return;

      // 源码模式：与渲染模式一致的"平滑滚动 + 锁高亮 + 结束后落光标"
      const sourceEl = deps.sourceEl();
      if (deps.isSourceMode() && sourceEl) {
        controller.setActive(index);
        jumpLocked = true;
        if (
          !jumpInSource(sourceEl, entries, index, () => {
            controller.setActive(index);
            jumpLocked = false;
          })
        ) {
          jumpLocked = false;
          return;
        }
        return;
      }

      // 渲染模式：先平滑滚动、滚动完成后再设置选区。
      // 顺序是本功能成败关键：若先 dispatch 选区，浏览器会立刻把光标
      // 滚入视口（瞬移一下），随后 smooth 再滚一遍（移动）——两段叠加
      // 就是"闪一下再移动"的抽动；先滚后选则只有一次平滑动画。
      // 高亮在滚动期间锁定（jumpLocked），结束后一次 setActive，
      // 避免滚过中间标题时高亮闪烁。
      const container = document.querySelector('#editor-container') as HTMLElement;
      let scrollTarget = -1;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        // 直接按 heading 层级从 DOM 里找对应标题（比 domAtPos 更可靠）
        const allHeadings = view.dom.querySelectorAll('h1, h2, h3, h4, h5, h6');
        const headingEl = allHeadings[index] as HTMLElement | undefined;
        if (headingEl && container) {
          const headingRect = headingEl.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();
          // rect 差值（屏幕像素）÷zoom → 局部单位后再加 scrollTop（见 screenPxToLocal）
          scrollTarget =
            screenPxToLocal(container, headingRect.top - containerRect.top) + container.scrollTop;
        }
      });

      const finishJump = (): void => {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const $pos = view.state.doc.resolve(target.pos + 1);
          const selection = TextSelection.near($pos, 1);
          view.dispatch(view.state.tr.setSelection(selection));
          // 目标已在视口内：焦点还给编辑器（preventScroll 防原生 focus 滚动）
          view.dom.focus({ preventScroll: true });
        });
        controller.setActive(index);
        jumpLocked = false;
      };

      // 先置高亮：点击瞬间反馈（即便锁定期间也不需等滚动完才亮）
      controller.setActive(index);
      jumpLocked = true;
      if (container && scrollTarget >= 0 && container.scrollTop !== scrollTarget) {
        // scrollend 事件（Chromium 支持）或超时兜底后落光标 + 解锁
        let finished = false;
        const finish = (): void => {
          if (finished) return;
          finished = true;
          finishJump();
        };
        container.addEventListener('scrollend', finish, { once: true });
        window.setTimeout(finish, SCROLL_ANIMATION_TIMEOUT_MS);
        container.scrollTo({ top: scrollTarget, behavior: 'smooth' });
      } else {
        finishJump();
      }
    }
  };

  // 滚动联动：视口顶部附近的标题决定 outline active（rAF 合并每帧多次 scroll）。
  // 跳转期间必须锁定：平滑滚动的过程会滚过一串中间标题，不及时加锁，
  // updateActiveFromScroll 会把高亮反复改到"正在经过"的标题上——
  // 用户看到的就是"当前高亮消失一下，滚到位后再次出现"。
  let scrollPending = false;
  let jumpLocked = false;
  const onScroll = (): void => {
    if (jumpLocked) return;
    if (scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(() => {
      scrollPending = false;
      controller.updateActiveFromScroll();
    });
  };
  document
    .querySelector('#editor-container')
    ?.addEventListener('scroll', onScroll, { passive: true });
  deps.sourceEl()?.addEventListener('scroll', onScroll, { passive: true });

  return controller;
}

/** 计算光标当前所在标题的序号（用于高亮大纲项） */
export function activeHeadingIndex(editor: Editor, totalHeadings: number): number | null {
  let result: number | null = null;

  editor.action((ctx) => {
    const state = ctx.get(editorViewCtx).state;
    const $from = state.selection.$from;

    let headingDepth = -1;
    for (let depth = $from.depth; depth >= 0; depth--) {
      if ($from.node(depth).type.name === 'heading') {
        headingDepth = depth;
        break;
      }
    }
    if (headingDepth < 0) return;

    // 计算该标题是文档中的第几个 heading
    const headingPos = $from.before(headingDepth);
    let index = 0;
    let found = false;
    state.doc.descendants((node, pos) => {
      if (found) return false;
      if (node.type.name === 'heading') {
        if (pos === headingPos) {
          found = true;
          return false;
        }
        index++;
      }
      return true;
    });

    if (found && index < totalHeadings) result = index;
  });

  return result;
}
