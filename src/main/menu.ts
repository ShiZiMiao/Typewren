import { app, BrowserWindow, dialog, ipcMain, Menu, MenuItemConstructorOptions } from 'electron';

import { sendCommand } from './io';
import { createMainWindow } from './window';
import { checkForUpdates } from './updater';
import { clearRecentFiles, getRecentFiles } from './docRegistry';
import { MENU_TOP_LABELS } from '../shared/menu';
import type { CommandName } from '../shared/ipc';

function item(
  label: string,
  command: CommandName,
  accelerator?: string,
  payload?: unknown
): MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    click: (_menuitem, focusedWindow) => {
      const win =
        focusedWindow instanceof BrowserWindow ? focusedWindow : BrowserWindow.getAllWindows()[0];
      if (win) sendCommand(win, command, payload);
    }
  };
}

function buildRecentSubmenu(): MenuItemConstructorOptions[] {
  const items = getRecentFiles().map((filePath): MenuItemConstructorOptions => ({
    label: filePath.replace(/\\/g, '/').split('/').pop() ?? filePath,
    // 与「文件→打开…」同逻辑（空文档就地、否则新窗口）：
    // 由渲染层 fileService.openSmart 统一裁决，这里只转发命令
    click: (_mi, win) => {
      const target = win instanceof BrowserWindow ? win : BrowserWindow.getAllWindows()[0];
      if (target) sendCommand(target, 'file:open-smart', filePath);
    }
  }));
  if (items.length === 0) {
    return [{ label: '（无最近文件）', enabled: false }];
  }
  return [
    ...items,
    { type: 'separator' },
    { label: '清除最近记录', click: () => clearRecentFiles() }
  ];
}

function buildTemplate(): MenuItemConstructorOptions[] {
  return [
    // ---------- 文件 ----------
    {
      label: MENU_TOP_LABELS[0],
      submenu: [
        // 新建窗口直接在主进程闭环，不经渲染层命令
        { label: '新建窗口', accelerator: 'CmdOrCtrl+Shift+N', click: () => createMainWindow() },
        { type: 'separator' },
        item('新建', 'new-file', 'CmdOrCtrl+N'),
        item('打开…', 'open-file', 'CmdOrCtrl+O'),
        { label: '最近文件', submenu: buildRecentSubmenu() },
        { type: 'separator' },
        item('保存', 'save', 'CmdOrCtrl+S'),
        item('另存为…', 'save-as', 'CmdOrCtrl+Shift+S'),
        item('在资源管理器中显示', 'global:show-in-folder'),
        {
          label: '导出',
          submenu: [
            item('导出为 PDF…', 'export:pdf'),
            item('导出为 HTML…', 'export:html'),
            item('导出为 Word 文档…', 'export:docx'),
            item('导出为图片（PNG）…', 'export:png')
          ]
        },
        { type: 'separator' },
        // 多窗口下 Ctrl+W 关闭当前窗口（最后一个窗口关闭即退出，见 window-all-closed）
        { label: '关闭窗口', role: 'close', accelerator: 'CmdOrCtrl+W' },
        { label: '退出', role: 'quit' }
      ]
    },
    // ---------- 编辑 ----------
    {
      label: MENU_TOP_LABELS[1],
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
        { type: 'separator' },
        item('查找…', 'edit:find', 'CmdOrCtrl+F'),
        item('替换…', 'edit:replace', 'CmdOrCtrl+H'),
        { type: 'separator' },
        item('拼写检查', 'edit:spellcheck'),
        item('成对符号补全', 'edit:auto-pairs')
      ]
    },
    // ---------- 格式 ----------
    {
      label: MENU_TOP_LABELS[2],
      submenu: [
        item('加粗', 'format:bold', 'CmdOrCtrl+B'),
        item('斜体', 'format:italic', 'CmdOrCtrl+I'),
        item('删除线', 'format:strike', 'CmdOrCtrl+Shift+X'),
        item('行内代码', 'format:inline-code', 'CmdOrCtrl+`'),
        { type: 'separator' },
        item('插入链接…', 'format:link', 'CmdOrCtrl+K'),
        item('插入图片…', 'format:image', 'CmdOrCtrl+Shift+I')
      ]
    },
    // ---------- 段落 ----------
    {
      label: MENU_TOP_LABELS[3],
      submenu: [
        item('一级标题', 'heading', 'CmdOrCtrl+1', 1),
        item('二级标题', 'heading', 'CmdOrCtrl+2', 2),
        item('三级标题', 'heading', 'CmdOrCtrl+3', 3),
        item('四级标题', 'heading', 'CmdOrCtrl+4', 4),
        item('五级标题', 'heading', 'CmdOrCtrl+5', 5),
        item('六级标题', 'heading', 'CmdOrCtrl+6', 6),
        item('正文', 'heading', 'CmdOrCtrl+0', 0),
        { type: 'separator' },
        item('无序列表', 'list:bullet'),
        item('有序列表', 'list:number'),
        item('任务列表', 'list:task'),
        item('引用块', 'block:quote'),
        { type: 'separator' },
        item('代码块', 'block:code', 'CmdOrCtrl+Alt+C'),
        item('数学公式块', 'block:math', 'CmdOrCtrl+Shift+M'),
        item('表格', 'insert:table'),
        item('水平线', 'insert:hr')
      ]
    },
    // ---------- 视图 ----------
    {
      label: MENU_TOP_LABELS[4],
      submenu: [
        item('源代码模式', 'view:source', 'CmdOrCtrl+/'),
        item('大纲面板', 'view:outline', 'CmdOrCtrl+\\'),
        item('焦点模式', 'view:focus-mode'),
        item('打字机模式', 'view:typewriter-mode'),
        item('切换亮色 / 暗色主题', 'view:theme', 'CmdOrCtrl+Shift+L'),
        { type: 'separator' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '重置缩放', role: 'resetZoom' },
        // 重载 / 开发者工具只在开发期暴露（打包版用户不需要）
        ...(!app.isPackaged
          ? ([
              { type: 'separator' },
              { label: '重新加载', role: 'reload' },
              { label: '强制重新加载', role: 'forceReload' },
              { label: '开发者工具', role: 'toggleDevTools' }
            ] satisfies MenuItemConstructorOptions[])
          : [])
      ]
    },
    // ---------- 帮助 ----------
    {
      label: MENU_TOP_LABELS[5],
      submenu: [
        {
          label: '检查更新…',
          click: () => checkForUpdates(false)
        },
        { type: 'separator' },
        {
          label: '关于 Typewren',
          click: () => {
            dialog.showMessageBoxSync({
              type: 'info',
              title: '关于 Typewren',
              message: `Typewren v${app.getVersion()}`,
              detail:
                '单栏所见即所得 Markdown 编辑器\n基于 Electron + Milkdown (ProseMirror)\n代码高亮：highlight.js · 公式渲染：KaTeX'
            });
          }
        }
      ]
    }
  ];
}

export function installApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate()));
}

/**
 * 用全新模板重建应用菜单。
 * Windows 上 nativeTheme 变化后菜单栏不会自动按新配色重绘，需整体重建一次。
 */
export function refreshApplicationMenu(): void {
  installApplicationMenu();
}

/** 顶层菜单项的子菜单（自绘菜单栏弹出用） */
function getSubmenuTemplate(label: string): MenuItemConstructorOptions[] | null {
  const top = buildTemplate().find((m) => m.label === label);
  if (!top || !('submenu' in top) || !Array.isArray(top.submenu)) return null;
  return top.submenu as MenuItemConstructorOptions[];
}

/**
 * 弹窗左边参数归一化：popup 的 x/y 在原生侧是 int——
 * 页面缩放（Ctrl+=/-）后 getBoundingClientRect 产生小数坐标（如 7.5px），
 * gin 转换失败弹 "Error processing argument"；必须取整、非有限数放弃。
 */
export function normalizePopupPosition(x: unknown, y: unknown): { x: number; y: number } | null {
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  const nx = Math.round(x);
  const ny = Math.round(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  return { x: nx, y: ny };
}

/**
 * 注册自绘菜单栏的弹出通道：渲染层点击顶级项时，
 * 由主进程把对应子菜单以原生样式弹出在指定窗口坐标。
 */
export function registerMenuPopup(): void {
  ipcMain.on('menu:popup', (event, payload: { label: string; x: number; y: number }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    if (
      !payload ||
      typeof payload.label !== 'string' ||
      typeof payload.x !== 'number' ||
      typeof payload.y !== 'number'
    ) {
      return;
    }
    const sub = getSubmenuTemplate(payload.label);
    if (!sub) return;
    const pos = normalizePopupPosition(payload.x, payload.y);
    if (!pos) return;
    // 测试模式不真实弹出：窗口已抑制显示（--test/--headless），但 Menu.popup
    // 仍会试着把菜单弹到屏幕（窗口 bounds 位于原点时就是左上角冒菜单，
    // 用户看到的就是测试跑出的"莫名其妙弹窗"）。参数校验路径完整保留。
    if (process.argv.includes('--test') || process.argv.includes('--headless')) return;
    Menu.buildFromTemplate(sub).popup({
      window: win,
      x: pos.x,
      y: pos.y
    });
  });
}
