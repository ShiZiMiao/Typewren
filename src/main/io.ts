import { BrowserWindow, ipcMain, dialog, nativeTheme, shell } from 'electron';
import { promises as fsp } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { TITLEBAR_PALETTE } from '../shared/titlebar';
import { setWindowDoc } from './docRegistry';
import {
  MD_FILTERS,
  isConfirmDialogPayload,
  isFileContentPayload,
  isMarkdownPath,
  isSaveAsPayload,
  type CommandName,
  type DirEntry,
  type FileContentPayload,
  type PendingOpenResult,
  type SaveAsPayload,
  type SaveAsResult
} from '../shared/ipc';

/** 每个窗口的脏状态（渲染进程通过 IPC 同步） */
const dirtyMap = new WeakMap<BrowserWindow, boolean>();
/** 已确认强制关闭（跳过保存保护） */
const forceCloseSet = new WeakSet<BrowserWindow>();
/** 关闭确认框正在显示中（防止重复弹出） */
const closePrompting = new WeakSet<BrowserWindow>();
/**
 * 每个窗口"待打开"的文件（新建窗口时登记，渲染进程就绪后来取）。
 * 不用 did-finish-load 后推送 cmd——渲染层要等 createEditor 完成才订阅 cmd，
 * 推送早于订阅会静默丢失；改为就绪后主动拉取，天然无竞态。
 * content 有值时直接使用（崩溃恢复场景，不读磁盘），否则领取时才读。
 */
interface PendingRecord {
  path: string;
  content?: string;
  restore?: boolean;
}
const pendingOpens = new WeakMap<Electron.WebContents, PendingRecord>();

/** 为窗口登记一个待打开文件（配合渲染层的 take-pending-open 拉取）。
 * content 随附时为崩溃恢复草稿（不读磁盘，restore 标记呈未保存态）。 */
export function registerPendingOpen(
  win: BrowserWindow,
  filePath: string,
  content?: string,
  restore?: boolean
): void {
  pendingOpens.set(win.webContents, { path: filePath, content, restore });
  // 主进程创建窗口时即知道它将打开什么：先记入登记表，
  // 避免"刚开文件就退出"时渲染层异步的 win:set-path 还没到、会话/最近漏记
  if (content === undefined) {
    setWindowDoc(win, resolve(filePath));
  }
}

function winOf(sender: Electron.WebContents): BrowserWindow | null {
  return BrowserWindow.fromWebContents(sender);
}

/** 向指定窗口的渲染进程派发一条命令 */
export function sendCommand(win: BrowserWindow, name: CommandName, payload?: unknown): void {
  if (!win.isDestroyed()) win.webContents.send('cmd', name, payload);
}

/**
 * 关闭保护：文档未保存时拦截关闭请求，
 * 弹出原生对话框让用户选择 保存 / 不保存 / 取消。
 * 两个后续动作都交回渲染进程完成（保存后 / 放弃后各自回调 request-force-close），
 * 以便渲染层同步清理崩溃恢复草稿。
 * 必须用异步 showMessageBox：同步版会阻塞主进程事件循环，
 * 多窗口下其它窗口的 IPC（脏同步 / 主题广播 / 更新进度）会被一起卡住。
 */
export function attachCloseGuard(win: BrowserWindow): void {
  // 测试模式跳过关闭保护
  if (process.argv.includes('--test')) return;

  win.on('close', (event) => {
    if (!dirtyMap.get(win) || forceCloseSet.has(win) || closePrompting.has(win)) return;

    event.preventDefault();
    closePrompting.add(win);

    void (async () => {
      try {
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          title: 'Typewren',
          message: '文档尚未保存',
          detail: '你的更改将在关闭后丢失。是否保存更改？',
          buttons: ['保存', '不保存', '取消'],
          defaultId: 0,
          cancelId: 2,
          noLink: true
        });
        if (response === 0) {
          // 让渲染进程先执行保存流程（无路径时会另存为），完成后回调
          sendCommand(win, 'save-and-close');
        } else if (response === 1) {
          // 放弃更改：渲染层清理草稿后回调强制关闭
          sendCommand(win, 'discard-close');
        }
        // response === 2：取消，什么都不做
      } finally {
        closePrompting.delete(win);
      }
    })();
  });
}

export function registerIpcHandlers(): void {
  // ---------- 打开文件 ----------
  ipcMain.handle('dialog:open-file', async (event): Promise<FileContentPayload | null> => {
    const win = winOf(event.sender);
    if (!win) return null;

    const result = await dialog.showOpenDialog(win, {
      title: '打开 Markdown 文件',
      properties: ['openFile'],
      filters: MD_FILTERS
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const filePath = result.filePaths[0];
    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      return { path: filePath, content };
    } catch (error) {
      dialog.showErrorBox('无法读取文件', String(error));
      return null;
    }
  });

  // ---------- 另存为 ----------
  ipcMain.handle(
    'dialog:save-as',
    async (event, payload: SaveAsPayload): Promise<SaveAsResult | null> => {
      const win = winOf(event.sender);
      if (!win) return null;
      if (!isSaveAsPayload(payload)) return null;

      const result = await dialog.showSaveDialog(win, {
        title: '另存为',
        defaultPath: payload.suggestedName ?? '未命名.md',
        filters: MD_FILTERS
      });
      if (result.canceled || !result.filePath) return null;

      try {
        await fsp.writeFile(result.filePath, payload.content, 'utf-8');
        return { path: result.filePath };
      } catch (error) {
        dialog.showErrorBox('无法写入文件', String(error));
        return null;
      }
    }
  );

  // ---------- 直接写文件（已知路径的保存） ----------
  ipcMain.handle('file:write', async (_event, payload: FileContentPayload) => {
    if (!isFileContentPayload(payload) || !isAbsolute(payload.path)) {
      return false;
    }
    try {
      await fsp.writeFile(payload.path, payload.content, 'utf-8');
      return true;
    } catch (error) {
      dialog.showErrorBox('无法保存文件', String(error));
      return false;
    }
  });

  // ---------- 放弃更改确认（新建 / 打开前调用） ----------
  ipcMain.handle('dialog:discard-changes', async (event) => {
    const win = winOf(event.sender);
    if (!win) return 'cancel';

    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Typewren',
      message: '当前文档尚未保存',
      detail: '是否保存当前更改？',
      buttons: ['保存', '放弃更改', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });

    return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
  });

  // ---------- 窗口元信息 ----------
  ipcMain.on('win:set-title', (event, title: string) => {
    const win = winOf(event.sender);
    if (win && typeof title === 'string') win.setTitle(title);
  });

  ipcMain.on('win:set-dirty', (event, dirty: boolean) => {
    const win = winOf(event.sender);
    if (win) dirtyMap.set(win, Boolean(dirty));
  });

  // 当前文档路径（会话恢复 / 最近文件 / 重复打开检测的数据源）
  ipcMain.on('win:set-path', (event, path: unknown) => {
    const win = winOf(event.sender);
    if (!win) return;
    setWindowDoc(win, typeof path === 'string' && path.length > 0 ? path : null);
  });

  ipcMain.on('win:request-force-close', (event) => {
    const win = winOf(event.sender);
    if (!win) return;
    forceCloseSet.add(win);
    dirtyMap.set(win, false);
    win.close();
  });

  // ---------- 原生主题联动（标题栏 / 菜单栏 / 原生控件配色） ----------
  ipcMain.on('theme:set-native', (_event, theme: string) => {
    if (theme === 'light' || theme === 'dark' || theme === 'system') {
      nativeTheme.themeSource = theme;
    }
  });

  // ---------- 拉取本窗口的待打开文件（新窗口就绪后主动取，取后即删） ----------
  ipcMain.handle('file:take-pending-open', async (event): Promise<PendingOpenResult | null> => {
    const record = pendingOpens.get(event.sender);
    if (!record) return null;
    pendingOpens.delete(event.sender);
    // 路径统一归一化为绝对路径（命令行参数可能是相对路径）
    const absolutePath = resolve(record.path);
    if (typeof record.content === 'string') {
      // 崩溃恢复草稿：内容随附，不读磁盘
      return { path: absolutePath, content: record.content, restore: record.restore };
    }
    try {
      const content = await fsp.readFile(absolutePath, 'utf-8');
      return { path: absolutePath, content };
    } catch (error) {
      dialog.showErrorBox('无法打开文件', String(error));
      return null;
    }
  });

  // ---------- 静默读取文件（外部修改检测用；不弹框，失败/不存在返回 null） ----------
  ipcMain.handle('file:read-quiet', async (_event, filePath: unknown): Promise<string | null> => {
    if (typeof filePath !== 'string' || !isMarkdownPath(filePath)) return null;
    try {
      return await fsp.readFile(resolve(filePath), 'utf-8');
    } catch {
      return null;
    }
  });

  // ---------- 列出 Markdown 文件（文件树面板；目录限于文档目录子树，防越权） ----------
  ipcMain.handle('dir:list', async (_event, payload: unknown): Promise<DirEntry[]> => {
    if (typeof payload !== 'object' || payload === null) return [];
    const { docPath, dirPath } = payload as { docPath?: unknown; dirPath?: unknown };
    if (typeof docPath !== 'string' || !isMarkdownPath(docPath) || typeof dirPath !== 'string') {
      return [];
    }
    const root = dirname(resolve(docPath));
    const dir = resolve(dirPath);
    // 只能列根目录及其子树（同级横向/上级访问一律拒绝）
    const normalized = dir.toLowerCase();
    const rootNorm = root.toLowerCase();
    const inTree = normalized === rootNorm || normalized.startsWith(rootNorm + '\\');
    if (!inTree) return [];

    try {
      // 异步读目录：文件树面板是用户高频交互，同步 readdirSync 会阻塞主进程
      const names = await fsp.readdir(dir, { withFileTypes: true });
      const entries: DirEntry[] = [];
      for (const ent of names) {
        const fullPath = join(dir, ent.name);
        if (ent.isDirectory()) {
          entries.push({ name: ent.name, fullPath, isDir: true, isMarkdown: false });
        } else if (ent.isFile() && isMarkdownPath(ent.name)) {
          entries.push({ name: ent.name, fullPath, isDir: false, isMarkdown: true });
        }
      }
      // 目录在前字母序，Markdown 文件按名称
      return entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-CN');
      });
    } catch {
      return [];
    }
  });

  // ---------- 在资源管理器中显示文件 ----------
  ipcMain.on('file:show-in-folder', (_event, filePath: unknown) => {
    if (typeof filePath === 'string' && filePath.length > 0) {
      shell.showItemInFolder(resolve(filePath));
    }
  });

  // ---------- 通用确认对话框（外部修改冲突 / 附件迁移等渲染层发起的询问） ----------
  ipcMain.handle('dialog:confirm', async (event, payload: unknown): Promise<number | null> => {
    if (!isConfirmDialogPayload(payload)) return null;
    const win = winOf(event.sender);
    const options = {
      type: 'question' as const,
      title: 'Typewren',
      message: payload.message,
      detail: payload.detail,
      buttons: payload.buttons,
      cancelId: payload.cancelId ?? payload.buttons.length - 1,
      noLink: true
    };
    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    return response;
  });

  // ---------- 读取文件内容（拖放到当前窗口用） ----------
  ipcMain.handle(
    'file:read-content',
    async (_event, filePath: string): Promise<FileContentPayload | null> => {
      // 渲染层只能读取受支持的 Markdown 文件（拖拽打开场景），
      // 拒绝任意路径读取（防渲染层被攻破后读取敏感文件）
      if (typeof filePath !== 'string' || !isMarkdownPath(filePath)) return null;
      try {
        const absolutePath = resolve(filePath);
        const content = await fsp.readFile(absolutePath, 'utf-8');
        return { path: absolutePath, content };
      } catch (error) {
        // 与 dialog:open-file 保持一致：弹框提示并返回 null，不向渲染端抛出
        dialog.showErrorBox('无法读取文件', String(error));
        return null;
      }
    }
  );
}

/**
 * 原生主题同步桥：nativeTheme 一旦变化（用户切换或系统偏好变化），
 * 立即广播 shouldUseDarkColors 给所有渲染进程，作为内容配色的统一时钟；
 * Windows 上同时强制重建菜单栏并触发非客户区重绘，避免标题栏 / 菜单栏迟一拍才变色。
 */
export function attachNativeThemeSync(refreshMenu: () => void): void {
  nativeTheme.on('updated', () => {
    const dark = nativeTheme.shouldUseDarkColors;
    const palette = dark ? TITLEBAR_PALETTE.dark : TITLEBAR_PALETTE.light;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send('theme:native-updated', dark);
      if (process.platform === 'win32') {
        // 即时重设标题栏按钮区配色（程序化设置，无 DWM 渐变），
        // 使标题栏与内容同刻切换
        win.setTitleBarOverlay({
          color: palette.color,
          symbolColor: palette.symbolColor
        });
        // 强制重设标题触发 DWM 非客户区按新主题重绘（零视觉副作用）
        win.setTitle(win.getTitle());
      }
    }
    if (process.platform === 'win32') refreshMenu();
  });
}
