import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx } from '@milkdown/kit/core';

import { localStore } from '../util/storage';

/* ============================================================
 * 拼写检查开关（设置收口：settings.json 权威，localStorage 镜像兼容测试预置）：
 * - 渲染层切换编辑器 contenteditable 的 spellcheck 属性（随编辑框启用）；
 * - 主进程 session.setSpellCheckerEnabled（红波浪线检测域）由设置广播
 *   （main/settings.ts 副作用）统一驱动，不再单独 IPC。
 * 状态来源优先级：localStorage 镜像（存在时，测试预置/首帧）> 设置存储。
 * ============================================================ */

const SPELLCHECK_KEY = 'typewren.spellcheck';

export class SpellcheckController {
  private enabled: boolean;

  constructor(
    private readonly editor: Editor,
    initial: boolean
  ) {
    const stored = localStore.get(SPELLCHECK_KEY);
    this.enabled = stored !== null ? stored === '1' : initial;
    this.applyDom();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  toggle(): void {
    this.onToggle(!this.enabled);
  }

  /** 设置存储应用点：同步状态与 DOM（镜像缓存保持同步，供 reload 预置） */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    localStore.set(SPELLCHECK_KEY, enabled ? '1' : '0');
    this.applyDom();
  }

  /** 供主装配注入：把开关变更写回设置存储（onToggle 参数为下一状态） */
  onToggle: (next: boolean) => void = () => {};

  private applyDom(): void {
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dom.setAttribute('spellcheck', this.enabled ? 'true' : 'false');
      (view.dom as HTMLDivElement).spellcheck = this.enabled;
    });
  }
}

export function createSpellcheck(editor: Editor, initial: boolean): SpellcheckController {
  return new SpellcheckController(editor, initial);
}
