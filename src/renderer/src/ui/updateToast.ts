/* ============================================================
 * 更新下载提示卡（右下角非模态浮层）
 * 由主进程 updater:download-state 推送驱动：
 * starting → progress（百分比/速度/已下载量）→ done / canceled / error。
 * 下载中可点「取消下载」；done / canceled / error 停留几秒后自动收起。
 * ============================================================ */

import type { UpdateDownloadState } from '../../../shared/ipc';

const AUTO_HIDE_MS = 8000;

/** 字节数 → 人类可读（1000 字节按 1000 计更符合文件体积直觉 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

export class UpdateDownloadToast {
  private panel: HTMLElement;
  private titleEl: HTMLElement;
  private barFill: HTMLElement;
  private metaEl: HTMLElement;
  private cancelBtn: HTMLButtonElement;
  private hideTimer: number | undefined;
  /** 手动静默标志：用户点「✕ 关闭」后不再被 progress 顶开，
   * 直到 done/canceled/error 的终态事件才解除并重新展示 */
  private muted = false;

  constructor() {
    /* ---------- DOM ---------- */
    const panel = document.createElement('aside');
    panel.id = 'update-download-panel';
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');

    const head = document.createElement('div');
    head.className = 'udp-head';
    const title = document.createElement('span');
    title.className = 'udp-title';
    title.textContent = '更新';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'udp-close';
    closeBtn.title = '关闭提示';
    closeBtn.textContent = '✕';
    head.append(title, closeBtn);

    const bar = document.createElement('div');
    bar.className = 'udp-bar';
    const fill = document.createElement('div');
    fill.className = 'udp-fill';
    fill.style.width = '0%';
    bar.appendChild(fill);

    const meta = document.createElement('div');
    meta.className = 'udp-meta';
    meta.textContent = ' ';

    const actions = document.createElement('div');
    actions.className = 'udp-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'udp-btn';
    cancelBtn.textContent = '取消下载';
    actions.appendChild(cancelBtn);

    panel.append(head, bar, meta, actions);
    panel.classList.add('hidden');
    document.body.appendChild(panel);

    this.panel = panel;
    this.titleEl = title;
    this.barFill = fill;
    this.metaEl = meta;
    this.cancelBtn = cancelBtn;

    /* ---------- 交互 ---------- */
    closeBtn.addEventListener('click', () => {
      // 手动收起 = 静默：下载中的 progress 推送会不断刷新，无条件 show()
      // 会把刚关掉的面板顶回来（"✕ 关闭点了没用"）——置 muted 直到终态
      this.muted = true;
      this.hide();
    });
    cancelBtn.addEventListener('click', () => {
      // 立即本地收起，主进程随后推送 canceled 状态幂等覆盖
      window.typewren.cancelUpdateDownload();
      this.applyState({ phase: 'canceled' });
    });

    /* ---------- 订阅主进程下载状态（提示卡常驻不销毁，无需退订） ---------- */
    window.typewren.onUpdateDownloadState((state) => this.applyState(state));
  }

  /** 暴露给测试/调试：手动推送一个状态 */
  applyState(state: UpdateDownloadState): void {
    window.clearTimeout(this.hideTimer);
    this.hideTimer = undefined;

    switch (state.phase) {
      case 'starting':
        this.titleEl.textContent = `正在下载更新 v${state.version}`;
        this.setBar(0, true);
        this.metaEl.textContent = '正在获取安装包…';
        this.cancelBtn.style.display = '';
        this.showUnlessMuted();
        break;
      case 'progress':
        this.titleEl.textContent = `正在下载更新 v${state.version}`;
        this.setBar(state.percent, state.percent <= 0);
        this.metaEl.textContent = `${state.percent}% · ${formatBytes(state.transferred)} / ${formatBytes(state.total)} · ${formatBytes(state.bytesPerSecond)}/s`;
        this.cancelBtn.style.display = '';
        this.showUnlessMuted();
        break;
      case 'done':
        this.titleEl.textContent = '更新已就绪';
        this.setBar(100, false);
        this.metaEl.textContent = `v${state.version} 下载完成，等待安装`;
        this.cancelBtn.style.display = 'none';
        this.muted = false;
        this.show();
        this.autoHide();
        break;
      case 'canceled':
        this.titleEl.textContent = '已取消下载';
        this.setBar(0, false);
        this.metaEl.textContent = '未安装任何更新';
        this.cancelBtn.style.display = 'none';
        this.muted = false;
        this.show();
        this.autoHide();
        break;
      case 'error':
        this.titleEl.textContent = '更新下载失败';
        this.setBar(0, false);
        this.metaEl.textContent = state.message || '未知错误';
        this.cancelBtn.style.display = 'none';
        this.muted = false;
        this.show();
        this.autoHide();
        break;
    }
  }

  private setBar(percent: number, indeterminate: boolean): void {
    this.barFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    this.barFill.classList.toggle('indeterminate', indeterminate);
  }

  private show(): void {
    this.panel.classList.remove('hidden');
  }

  /** 下载中的状态更新不打断用户手动收起（muted 期间只更新数据不展示） */
  private showUnlessMuted(): void {
    if (this.muted) return;
    this.show();
  }

  private hide(): void {
    window.clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    this.panel.classList.add('hidden');
  }

  private autoHide(): void {
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), AUTO_HIDE_MS);
  }
}
