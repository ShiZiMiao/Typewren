import { app, BrowserWindow, dialog, ipcMain, Menu, MenuItemConstructorOptions } from 'electron';

import { sendCommand } from './io';
import { createMainWindow } from './window';
import { checkForUpdates } from './updater';
import { clearRecentFiles, getRecentFiles } from './docRegistry';
import { suppressesUi } from './runMode';
import { MENU_TOP_LABELS } from '../shared/menu';
import type { CommandName } from '../shared/ipc';

/**
 * 菜单项 + 运行时 command 字段（menu:popup 按渲染层状态补勾选态用）。
 * submenu 收窄为本类型数组，模板内嵌套项的 command 才能一路保留类型
 * （MenuItemConstructorOptions 本身不认识 command，旧实现靠 4 处裸断言透传）。
 */
interface CommandMenuItem extends MenuItemConstructorOptions {
  command?: CommandName;
  submenu?: CommandMenuItem[] | Menu;
}

function item(
  label: string,
  command: CommandName,
  accelerator?: string,
  payload?: unknown
): CommandMenuItem {
  return {
    label,
    accelerator,
    // 附带 command 供 menu:popup 按渲染层状态补 checkbox（运行时字段）
    command,
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

function buildTemplate(): CommandMenuItem[] {
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
        item('偏好设置…', 'file:preferences', 'CmdOrCtrl+,'),
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
        item('背景图片设置…', 'view:background-settings'),
        item('切换亮色 / 暗色主题', 'view:theme', 'CmdOrCtrl+Shift+L'),
        { type: 'separator' },
        // 缩放必须写显式 accelerator：role zoomIn/zoomOut/resetZoom 的默认加速器
        // 实测失灵（zoomIn 默认串 CommandOrControl+Plus 无键可匹配），见 AGENTS.md 决策 #20。
        // Ctrl+0 让位给段落→正文；重置用 Ctrl+Shift+D（D=Default）——
        // Ctrl+Shift+数字疑似被中文输入法热键吞掉，菜单不显示数字组合。
        item('放大', 'view:zoom-in', 'CmdOrCtrl+='),
        item('缩小', 'view:zoom-out', 'CmdOrCtrl+-'),
        item('重置缩放', 'view:zoom-reset', 'CmdOrCtrl+Shift+D'),
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
            // 异步对话框：showMessageBoxSync 会阻塞主进程事件循环，
            // 多窗口下其它窗口的 IPC 一起卡死（同 AGENTS 决策 #15 的关闭保护坑）
            void dialog.showMessageBox({
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

/**
 * 勾选态补给：模板项若带 command 且渲染层上报了对应状态，
 * 转成 checkbox 项（menu:popup 每次重建模板，勾选态永远是最新）。
 */
function withCheckedStates(
  items: CommandMenuItem[],
  states: Record<string, boolean>
): CommandMenuItem[] {
  return items.map((m) => {
    const command = m.command;
    if (command && typeof states[command] === 'boolean') {
      return { ...m, type: 'checkbox' as const, checked: states[command] };
    }
    return m;
  });
}

/** 顶层菜单项的子菜单（自绘菜单栏弹出用） */
function getSubmenuTemplate(label: string): CommandMenuItem[] | null {
  const top = buildTemplate().find((m) => m.label === label);
  if (!top) return null;
  const sub = top.submenu;
  return Array.isArray(sub) ? sub : null;
}

/**
 * 弹出坐标归一化（纯函数）：渲染层传来的是 getBoundingClientRect 的
 * **视口 CSS 坐标**，而 popup 的 x/y 是**窗口客户区 DIP**——
 * 缩放后 CSS px ≠ DIP（css = dip / zoomFactor），须先 × zoomFactor 换算。
 * 两个坑一起收口：
 * ① 页面缩放后坐标是小数（如 7.5px），gin 侧 x/y 是 int，转换失败弹
 *   "Error processing argument"——换算后取整；
 * ② 缩放后弹出位置错位（缩小偏右下 / 放大偏左上）——漏乘 zoomFactor 所致，
 *   zoom=1 时恒等变换故此前没暴露。
 */
export function normalizePopupPosition(
  x: unknown,
  y: unknown,
  zoomFactor: unknown
): { x: number; y: number } | null {
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (typeof zoomFactor !== 'number' || !Number.isFinite(zoomFactor) || zoomFactor <= 0)
    return null;
  const nx = Math.round(x * zoomFactor);
  const ny = Math.round(y * zoomFactor);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  return { x: nx, y: ny };
}

/**
 * 注册自绘菜单栏的弹出通道：渲染层点击顶级项时，
 * 由主进程把对应子菜单以原生样式弹出在指定窗口坐标。
 */
export function registerMenuPopup(): void {
  ipcMain.on(
    'menu:popup',
    (event, payload: { label: string; x: number; y: number; states?: Record<string, boolean> }) => {
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
      // 视口 CSS 坐标 × zoomFactor → 窗口客户区 DIP（缩放后 CSS px ≠ DIP，见函数注释）
      const pos = normalizePopupPosition(payload.x, payload.y, win.webContents.getZoomFactor());
      if (!pos) return;
      // 测试模式不真实弹出：窗口已抑制显示（--test/--headless），但 Menu.popup
      // 仍会试着把菜单弹到屏幕（窗口 bounds 位于原点时就是左上角冒菜单，
      // 用户看到的就是测试跑出的"莫名其妙弹窗"）。参数校验路径完整保留。
      if (suppressesUi()) return;
      const states: Record<string, boolean> = {};
      if (payload.states && typeof payload.states === 'object') {
        for (const [key, value] of Object.entries(payload.states)) {
          if (typeof value === 'boolean') states[key] = value;
        }
      }
      Menu.buildFromTemplate(withCheckedStates(sub, states)).popup({
        window: win,
        x: pos.x,
        y: pos.y
      });
    }
  );
}
