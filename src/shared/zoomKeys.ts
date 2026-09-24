import type { ZoomAction } from './ipc';

/* ============================================================
 * 缩放键位映射 + 百分比语义（主进程 before-input-event 抢占层与渲染层共用）
 * 缩放实现是**内容区 CSS zoom**：只缩放编辑/源码区域的显示，UI 骨架不动，
 * 状态以百分比表达（50%–300%，步进 10 个百分点）。
 * ============================================================ */

export const ZOOM_PERCENT_MIN = 50;
export const ZOOM_PERCENT_MAX = 300;
export const ZOOM_PERCENT_STEP = 10;
export const ZOOM_PERCENT_DEFAULT = 100;

/** 钳制缩放百分比到合法区间并取整（纯函数；到顶/到底静默无操作） */
export function clampZoomPercent(percent: number): number {
  return Math.min(ZOOM_PERCENT_MAX, Math.max(ZOOM_PERCENT_MIN, Math.round(percent)));
}

export interface ZoomKeyInput {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  code: string;
  key: string;
  isComposing?: boolean;
}

/**
 * 判断按键对应的缩放动作。
 * e.code（Equal/Minus/KeyD/Digit0/NumpadAdd/NumpadSubtract/Numpad0）与 e.key 双判：
 * Ctrl++ 在多数布局是 Ctrl+Shift+Equal（key 为 '+'）、小键盘 ± 的 key 也是
 * '+'/'-'、键位产出随布局与输入法有差异，只看其一会漏。
 * 裸 Ctrl+0 一律不抢（归段落→正文），重置判定必须落在 Shift 语义上。
 */
export function resolveZoomAction(e: ZoomKeyInput): ZoomAction | null {
  if ((!e.ctrlKey && !e.metaKey) || e.altKey || e.isComposing) return null;
  if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.key === '+' || e.key === '=') return 'in';
  if (e.code === 'Minus' || e.code === 'NumpadSubtract' || e.key === '-' || e.key === '_')
    return 'out';
  // 重置主推 Ctrl+Shift+D（D=Default）：Ctrl+Shift+数字疑似被中文输入法热键吞掉
  // （真实按键失效而合成事件全通），数字组合仅留作备用判定、菜单不显示
  if (e.code === 'KeyD' && e.shiftKey) return 'reset';
  const zero = e.code === 'Digit0' || e.code === 'Numpad0' || e.key === '0';
  if (zero && e.shiftKey) return 'reset';
  // 部分布局/输入法把 Shift 语义折进 key（直接产出 ')'），shift 标志不可靠时兜底
  if (e.key === ')') return 'reset';
  return null;
}
