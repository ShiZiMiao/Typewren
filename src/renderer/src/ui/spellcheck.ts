import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx } from '@milkdown/kit/core';

/* ============================================================
 * 拼写检查开关：
 * - 渲染层切换编辑器 contenteditable 的 spellcheck 属性（随编辑框启用）；
 * - 经 IPC 同步主进程 session.setSpellCheckerEnabled（红波浪线检测域）。
 * 广播回声防护：onSpellcheckState 只改本地状态与 DOM 属性，
 * 不再回发 IPC（否则 主进程→广播→渲染→IPC→… 无限循环）。
 * ============================================================ */

const SPELLCHECK_KEY = 'typewren.spellcheck';

export class SpellcheckController {
  private enabled = localStorage.getItem(SPELLCHECK_KEY) === '1';
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly editor: Editor) {
    this.apply();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    localStorage.setItem(SPELLCHECK_KEY, this.enabled ? '1' : '0');
    this.apply();
    return this.enabled;
  }

  /** 主进程状态广播后同步（多窗口一致性）。注意：本回调不发 IPC（防回声循环） */
  bindBroadcast(): void {
    this.unsubscribe = window.typewren.onSpellcheckState((enabled) => {
      this.enabled = enabled;
      this.applyDom();
    });
  }

  destroy(): void {
    this.unsubscribe?.();
  }

  /** 渲染层 DOM 属性 + 主进程 session 设置 */
  private apply(): void {
    this.applyDom();
    window.typewren.setSpellcheck(this.enabled);
  }

  private applyDom(): void {
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dom.setAttribute('spellcheck', this.enabled ? 'true' : 'false');
      (view.dom as HTMLDivElement).spellcheck = this.enabled;
    });
  }
}

export function createSpellcheck(editor: Editor): SpellcheckController {
  return new SpellcheckController(editor);
}
