import type { ZoomAction } from '../../../shared/ipc';
import {
  ZOOM_PERCENT_DEFAULT,
  ZOOM_PERCENT_STEP,
  clampZoomPercent,
  resolveZoomAction
} from '../../../shared/zoomKeys';

/* ============================================================
 * 内容区缩放（只缩放编辑/源码区域，UI 骨架不动，见 AGENTS.md 决策 #20）
 * 实现 = 根上 --content-zoom 变量 + CSS `zoom` 挂 #editor-container/#source-textarea。
 * CSS zoom 语义（实测）：只缩放内部内容，元素盒子仍占原布局槽位——
 * 侧栏不被挤、无横向溢出；**勿对 width/max-width 做反向补偿**（会把列宽一起缩掉）；
 * 元素 getBoundingClientRect 是屏幕像素（与 fixed 定位一致），clientWidth 等是局部单位。
 * 键盘快捷键由主进程 before-input-event 抢占层（先于页面与菜单）转发 cmd 到此，
 * 渲染层 keydown 兜底保留（被抢占后页面收不到键，不会双触发）。
 * Ctrl+0 不抢（归段落→正文），重置缩放 Ctrl+Shift+D。
 * Ctrl+滚轮同此收口；监听器必须 passive:false 且无条件 preventDefault，
 * 抑制浏览器内置 Ctrl+滚轮缩放，防双触发。
 * ============================================================ */

let zoomPercent = ZOOM_PERCENT_DEFAULT;

/** 元素实际生效的 CSS zoom（未设置/异常回退 1）。
 * 取计算值而非根上 --content-zoom：谁真正带 zoom 谁就是"屏幕像素 ↔ 局部单位"
 * 的换算边界（#editor-container / #source-textarea），与 CSS 落点同源不漂。 */
export function elementZoom(el: Element): number {
  const raw = Number.parseFloat(window.getComputedStyle(el).getPropertyValue('zoom'));
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/**
 * rect 差值（屏幕像素）→ 元素滚动坐标（局部单位）。
 * CSS zoom 语义（实测，见顶部注释）：缩放子树内的 getBoundingClientRect
 * 是屏幕像素（×zoom），而 scrollTop / clientHeight 等是局部单位——
 * 二者直接相加会让滚动落点偏移 zoom 倍（放大过冲、缩小不足）。
 * 凡"rect 差值 + scrollTop"的落点公式必须先经此换算（positionSync /
 * outlinePanel / searchBar / writingModes 四处共用同一收口）。
 */
export function screenPxToLocal(el: Element, screenPx: number): number {
  return screenPx / elementZoom(el);
}

/** 应用缩放（菜单命令 / 快捷键 / 滚轮共用收口；到顶/到底静默无操作） */
export function applyZoomAction(action: ZoomAction): void {
  const base = action === 'reset' ? ZOOM_PERCENT_DEFAULT : zoomPercent;
  const delta = action === 'in' ? ZOOM_PERCENT_STEP : action === 'out' ? -ZOOM_PERCENT_STEP : 0;
  zoomPercent = clampZoomPercent(base + delta);
  document.documentElement.style.setProperty('--content-zoom', String(zoomPercent / 100));
}

/** 滚轮一步的累计阈值（像素）：普通滚轮一格约 100 直接步进，高分辨率触控板/捏合手势的
 * 小增量需累计到阈值才步进（否则转出残影般连跳） */
const WHEEL_STEP_THRESHOLD = 40;
/** deltaMode=1（行）/2（页）折算像素 */
const WHEEL_LINE_PX = 40;
const WHEEL_PAGE_PX = WHEEL_LINE_PX * 20;

/**
 * 滚轮缩放累计器（纯函数，供单测）：deltaY 归一化为像素并累计，
 * 达到阈值输出一步（上滚 deltaY<0 → 放大）并清零，否则继续累计。
 */
export function accumulateWheelDelta(
  acc: number,
  deltaY: number,
  deltaMode = 0
): { acc: number; action: ZoomAction | null } {
  const px = deltaY * (deltaMode === 1 ? WHEEL_LINE_PX : deltaMode === 2 ? WHEEL_PAGE_PX : 1);
  const sum = acc + px;
  if (Math.abs(sum) < WHEEL_STEP_THRESHOLD) return { acc: sum, action: null };
  return { acc: 0, action: sum < 0 ? 'in' : 'out' };
}

/** 安装缩放快捷键与 Ctrl+滚轮（document 捕获阶段，覆盖编辑器与源码 textarea） */
export function installZoomShortcut(): void {
  document.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      const action = resolveZoomAction(e);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      applyZoomAction(action);
    },
    true
  );

  let wheelAcc = 0;
  document.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      if ((!e.ctrlKey && !e.metaKey) || e.altKey) return;
      // 无条件吞掉默认行为：抑制浏览器内置 Ctrl+滚轮缩放，防双触发；
      // 未达累计阈值的小增量同样要 preventDefault（内置缩放按事件逐个响应）
      e.preventDefault();
      e.stopPropagation();
      const stepped = accumulateWheelDelta(wheelAcc, e.deltaY, e.deltaMode);
      wheelAcc = stepped.acc;
      if (stepped.action) applyZoomAction(stepped.action);
    },
    { capture: true, passive: false }
  );
}
