import { BrowserWindow, type WebContents } from 'electron';

import type { CommandName, ZoomAction } from '../shared/ipc';
import { sendCommand } from './io';
import { resolveZoomAction } from '../shared/zoomKeys';

const ZOOM_COMMAND: Record<ZoomAction, CommandName> = {
  in: 'view:zoom-in',
  out: 'view:zoom-out',
  reset: 'view:zoom-reset'
};

/**
 * 主进程缩放快捷键抢占层（before-input-event）。
 *
 * 该事件在页面 keydown **与菜单加速器之前**，preventDefault 可同时压制两者，
 * 是唯一可靠的抢占点：真实按键下菜单加速器疑似吞掉 Ctrl+Shift+数字
 * （被「正文」的 CmdOrCtrl+0 抢走执行无感知 heading 命令），在此抢先收口
 * 可免疫任何分发顺序变体。缩放实现是渲染层的内容区 CSS zoom，这里只负责
 * 抢键 + 转发 cmd 到同一收口；渲染层 ui/zoom.ts 的 keydown 兜底保留
 * （本层 preventDefault 后页面收不到键，不会双触发）。
 */
export function attachZoomShortcuts(contents: WebContents): void {
  // 页面级缩放归一：Chromium 的 zoom 按域名持久化（HostZoomMap，同源跨窗口/跨启动保留），
  // 旧版整页缩放（webContents.setZoomLevel）时代的负值残留会让**整个 UI** 渲染偏小。
  // 现在缩放只走内容区 CSS zoom，页面缩放必须恒为 1：建窗与每次导航完成后强制清零
  // （setZoomLevel(0) 同时把持久化值改写回 0，自愈且不会再漂）。
  const normalizePageZoom = (): void => contents.setZoomLevel(0);
  normalizePageZoom();
  contents.on('did-finish-load', normalizePageZoom);

  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const action = resolveZoomAction({
      code: input.code ?? '',
      key: input.key ?? '',
      ctrlKey: input.control,
      metaKey: input.meta,
      altKey: input.alt,
      shiftKey: input.shift
    });
    if (!action) return;
    event.preventDefault();
    const win = BrowserWindow.fromWebContents(contents);
    if (win) sendCommand(win, ZOOM_COMMAND[action]);
  });
}
