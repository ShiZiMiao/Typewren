import { BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { promises as fsp } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  MD_FILTERS,
  isConfirmDialogPayload,
  isFileContentPayload,
  isMarkdownPath,
  isOpenablePath,
  isImagePath,
  isSaveAsPayload,
  type CommandName,
  type DirEntry,
  type FileContentPayload,
  type PendingOpenResult,
  type SaveAsPayload,
  type SaveAsResult
} from '../shared/ipc';
import { absolutePathOrEmpty } from '../shared/pathKey';
import { forceCloseWindow, markWindowDirty, noteCloseFlowAborted } from './closeGuard';
import { recordRecentFile, setWindowDoc } from './docRegistry';
import { adoptDraft } from './drafts';

/* ============================================================
 * IPC 注册层（关闭保护在 closeGuard.ts、主题桥在 themeSync.ts）。
 * 安全口径：渲染层不可信——路径型载荷一律过 isOpenablePath / isImagePath
 * 白名单（扩展名），目录列举限文档目录子树，写入只允许可打开文档扩展名。
 * ============================================================ */

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
  /** 领取成功后记入最近文件（仅用户主动打开的记录，见 registerPendingOpen） */
  recent?: boolean;
}
const pendingOpens = new WeakMap<Electron.WebContents, PendingRecord>();

/** 为窗口登记一个待打开文件（配合渲染层的 take-pending-open 拉取）。
 * content 随附时为崩溃恢复草稿（不读磁盘，restore 标记呈未保存态）。
 * recent=true 才在领取成功后记入最近文件——会话/草稿恢复不算"最近使用"，
 * 否则会话恢复会把 MRU 重排成启动顺序（见 setWindowDoc 注释）。 */
export function registerPendingOpen(
  win: BrowserWindow,
  filePath: string,
  opts?: { content?: string; restore?: boolean; recent?: boolean }
): void {
  pendingOpens.set(win.webContents, {
    path: filePath,
    content: opts?.content,
    restore: opts?.restore,
    recent: opts?.recent
  });
  // 主进程创建窗口时即知道它将打开什么：先记入登记表（会话数据源 + 重复打开判重），
  // 避免"刚开文件就退出"时渲染层异步的 win:set-path 还没到、会话/最近漏记。
  // 空路径（未命名草稿）绝不能 resolve 成 cwd（会把 cwd 绑成文档路径，见 absolutePathOrEmpty）
  if (opts?.content === undefined) {
    const absolutePath = absolutePathOrEmpty(filePath);
    setWindowDoc(win, absolutePath || null, { recordRecent: false });
  }
}

function winOf(sender: Electron.WebContents): BrowserWindow | null {
  return BrowserWindow.fromWebContents(sender);
}

/** 向指定窗口的渲染进程派发一条命令 */
export function sendCommand(win: BrowserWindow, name: CommandName, payload?: unknown): void {
  if (!win.isDestroyed()) win.webContents.send('cmd', name, payload);
}

/** registerIpcHandlers 依赖注入（window.ts 的开窗逻辑；避免 io ↔ window 循环依赖） */
export interface IpcHandlerDeps {
  /** 在新窗口打开文件（含重复打开询问） */
  openFileInNewWindow: (parent: BrowserWindow | null, filePath: string) => Promise<void>;
}

export function registerIpcHandlers(deps: IpcHandlerDeps): void {
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
      if (result.canceled || !result.filePath) {
        // 取消另存为 = 保存流程中止（关闭保护的"保存"分支到此为止）
        noteCloseFlowAborted(win);
        return null;
      }

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
  ipcMain.handle('file:write', async (event, payload: FileContentPayload) => {
    const win = winOf(event.sender);
    // 限定可打开文档扩展名 + 绝对路径：不限扩展名的话，渲染层被攻破即可
    // 覆写任意绝对路径文件（系统文件/启动项）
    if (!isFileContentPayload(payload) || !isAbsolute(payload.path) || !isOpenablePath(payload.path)) {
      return false;
    }
    try {
      await fsp.writeFile(payload.path, payload.content, 'utf-8');
      return true;
    } catch (error) {
      // 写盘失败 = 保存流程中止（关闭保护的"保存"分支到此为止）
      noteCloseFlowAborted(win);
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
    if (win) markWindowDirty(win, Boolean(dirty));
  });

  // 当前文档路径（会话恢复 / 最近文件 / 重复打开检测的数据源）
  ipcMain.on('win:set-path', (event, path: unknown) => {
    const win = winOf(event.sender);
    if (!win) return;
    // 空串归 null 是既定契约（未命名文档语义，勿改成 resolve('')）
    setWindowDoc(win, typeof path === 'string' && path.length > 0 ? path : null);
  });

  ipcMain.on('win:request-force-close', (event) => {
    const win = winOf(event.sender);
    if (win) forceCloseWindow(win);
  });

  // ---------- 拉取本窗口的待打开文件（新窗口就绪后主动取，取后即删） ----------
  ipcMain.handle('file:take-pending-open', async (event): Promise<PendingOpenResult | null> => {
    const record = pendingOpens.get(event.sender);
    if (!record) return null;
    pendingOpens.delete(event.sender);
    // 路径统一归一化为绝对路径（命令行参数可能是相对路径）；
    // 空路径保持空串——未命名文档语义，resolve('') 会变成 cwd 并被绑成文档路径
    // （保存报 EISDIR、草稿永远清不掉，drafts.spec 有回归）
    const absolutePath = absolutePathOrEmpty(record.path);
    if (typeof record.content === 'string') {
      // 崩溃恢复草稿：内容随附，不读磁盘。re-key 到本窗口 sender 的草稿键上，
      // 使渲染层 clearDraft（按 sender 计键）能精确清掉它（见 drafts.adoptDraft）
      adoptDraft(event.sender.id, record.path, record.content);
      return { path: absolutePath, content: record.content, restore: record.restore };
    }
    try {
      const content = await fsp.readFile(absolutePath, 'utf-8');
      // 最近文件推迟到领取成功才登记：建窗即登记会让会话恢复把"最近使用"
      // 重排成启动顺序（MRU 失真），文件读不出来的失败打开也不该进最近
      if (record.recent && absolutePath) recordRecentFile(absolutePath);
      return { path: absolutePath, content };
    } catch (error) {
      dialog.showErrorBox('无法打开文件', String(error));
      return null;
    }
  });

  // ---------- 静默读取文件（外部修改检测用；不弹框，失败/不存在返回 null） ----------
  ipcMain.handle('file:read-quiet', async (_event, filePath: unknown): Promise<string | null> => {
    if (typeof filePath !== 'string' || !isOpenablePath(filePath)) return null;
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
    if (typeof docPath !== 'string' || !isOpenablePath(docPath) || typeof dirPath !== 'string') {
      return [];
    }
    const root = dirname(resolve(docPath));
    const dir = resolve(dirPath);
    // 只能列根目录及其子树（同级横向/上级访问一律拒绝）。
    // 判定用 path.relative：结果为空（根自身）、或不以 '..' 起始且非绝对路径
    // （跨盘符时 relative 直接返回绝对路径）即在子树内。旧实现硬编码 '\\' 前缀，
    // POSIX 下合法子目录全被误拒；win32 路径先整体小写再比（大小写不敏感）。
    const rel =
      process.platform === 'win32'
        ? relative(root.toLowerCase(), dir.toLowerCase())
        : relative(root, dir);
    const inTree = rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
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
    // 只放行可打开文档 / 图片路径：不过滤的话渲染层可让资源管理器"定位"任意字符串
    if (
      typeof filePath === 'string' &&
      filePath.length > 0 &&
      (isOpenablePath(filePath) || isImagePath(filePath))
    ) {
      shell.showItemInFolder(resolve(filePath));
    }
  });

  // ---------- 通用确认对话框（外部修改冲突 / 附件迁移等渲染层发起的询问） ----------
  ipcMain.handle('dialog:confirm', async (event, payload: unknown): Promise<number | null> => {
    if (!isConfirmDialogPayload(payload)) return null;
    const win = winOf(event.sender);
    try {
      const cancelId = payload.cancelId ?? payload.buttons.length - 1;
      const options = {
        type: 'question' as const,
        title: 'Typewren',
        message: payload.message,
        detail: payload.detail,
        buttons: payload.buttons,
        cancelId,
        noLink: true
      };
      const { response } = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
      // 用户选了"取消"性质按钮 = 依赖本确认的流程（保存的冲突处理等）中止，
      // 关闭保护的占用要释放，否则窗口带着"关闭中"状态直到看门狗超时
      if (response === cancelId) noteCloseFlowAborted(win);
      return response;
    } catch {
      // 对话框参数异常/宿主拒绝：兜底返回 null（渲染层按"取消"处理），不向渲染端抛出
      return null;
    }
  });

  // ---------- 读取文件内容（拖放到当前窗口用） ----------
  ipcMain.handle(
    'file:read-content',
    async (_event, filePath: string): Promise<FileContentPayload | null> => {
      // 渲染层只能读取受支持的可打开文档（拖拽打开场景），
      // 拒绝任意路径读取（防渲染层被攻破后读取敏感文件）
      if (typeof filePath !== 'string' || !isOpenablePath(filePath)) return null;
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

  // ---------- 新窗口打开（渲染层拖拽/最近文件等发起；重复打开询问） ----------
  ipcMain.on('file:open-in-new-window', (event, filePath: string) => {
    // 只放行受支持的可打开文档路径（拖拽/命令行打开场景，与渲染层过滤口径一致）
    if (typeof filePath !== 'string' || !isOpenablePath(filePath)) return;
    void deps.openFileInNewWindow(winOf(event.sender), filePath);
  });
}
