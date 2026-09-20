/* ============================================================
 * preload 暴露的 API 契约（单一来源）
 * preload/index.ts 实现它，渲染层 env.d.ts 引用它——两端不再各自声明，
 * 避免新增方法时一侧漏改导致类型漂移。
 * ============================================================ */

import type {
  AssetsCopyPayload,
  AssetsCopyResult,
  CommandName,
  ConfirmDialogPayload,
  DirEntry,
  ExportDocumentPayload,
  ExportDocumentResult,
  FileContentPayload,
  ImageDownloadPayload,
  ImageSaveFromDataPayload,
  ImageSaveFromPathPayload,
  ImageSaveResult,
  ListDirPayload,
  OpenFileResult,
  PendingOpenResult,
  SaveAsPayload,
  SaveAsResult,
  UpdateDownloadState
} from './ipc';
import type { AppSettings } from './settings';

export interface TypewrenApi {
  readonly platform: NodeJS.Platform;

  /** --test 模式标记（关闭草稿/恢复等会写用户数据目录的副作用） */
  readonly testMode: boolean;

  /** 草稿自动落盘间隔毫秒（env TYPEWREN_DRAFT_INTERVAL_MS 覆盖，测试用；空串=默认） */
  readonly draftIntervalMs: string;

  /** 弹出原生打开对话框，读取文件内容；取消或失败返回 null */
  openFileDialog(): Promise<OpenFileResult | null>;

  /** 弹出原生图片选择框（多选）；取消返回空数组 */
  openImageDialog(): Promise<string[]>;

  /** 弹出原生另存为对话框并写入；取消或失败返回 null */
  saveFileDialog(payload: SaveAsPayload): Promise<SaveAsResult | null>;

  /** 直接写入已知路径；失败弹错误框并返回 false */
  writeFile(payload: FileContentPayload): Promise<boolean>;

  /** 导出文档（HTML 写盘 / PDF 打印）；取消或失败返回相应标记 */
  exportDocument(payload: ExportDocumentPayload): Promise<ExportDocumentResult>;

  /** 把本地图片复制到资产目录（粘贴/拖拽的文件型图片） */
  saveImageFromPath(payload: ImageSaveFromPathPayload): Promise<ImageSaveResult>;

  /** 把剪贴板位图（base64）保存到资产目录 */
  saveImageFromData(payload: ImageSaveFromDataPayload): Promise<ImageSaveResult>;

  /** 下载网络图片并保存到资产目录（本地化） */
  downloadImage(payload: ImageDownloadPayload): Promise<ImageSaveResult>;

  /** 未保存时新建/打开前的确认，返回用户选择 */
  confirmDiscardChanges(): Promise<'save' | 'discard' | 'cancel'>;

  /** 通用原生确认框（外部修改冲突 / 附件迁移等），返回按钮下标；参数非法返回 null */
  confirmDialog(payload: ConfirmDialogPayload): Promise<number | null>;

  /** 静默读取 Markdown 文件内容（外部修改检测用）；不存在/不可读返回 null，不弹框 */
  readFileQuiet(filePath: string): Promise<string | null>;

  /** 列出文档目录（或其后代子目录）的 Markdown 文件与子目录（文件树面板） */
  listDir(payload: ListDirPayload): Promise<DirEntry[]>;

  /** 在系统资源管理器中定位文件 */
  showInFolder(filePath: string): void;

  /** 读取应用设置（preferences 对话框数据源；主进程读 userData/settings.json） */
  getSettings(): Promise<AppSettings>;

  /** 写入应用设置：主进程持久化、应用副作用（主题/拼写）并广播全部窗口 */
  setSettings(settings: AppSettings): void;

  /** 订阅设置变更广播（全部窗口，含发起方）；返回取消订阅函数 */
  onSettingsUpdated(callback: (settings: AppSettings) => void): () => void;

  /** 另存为后把源文档同目录 assets 的图片复制到新位置（已存在的跳过） */
  copyAssets(payload: AssetsCopyPayload): Promise<AssetsCopyResult>;

  /** 更新窗口标题 */
  setTitle(title: string): void;

  /** 同步原生主题（影响标题栏/菜单栏/滚动条配色） */
  setNativeTheme(theme: 'light' | 'dark' | 'system'): void;

  /**
   * 订阅原生主题变化（主进程 nativeTheme 'updated'）。
   * 参数为 shouldUseDarkColors；返回取消订阅函数。
   */
  onNativeThemeUpdated(callback: (dark: boolean) => void): () => void;

  /** 同步脏状态到主进程（关闭保护用） */
  setDirty(dirty: boolean): void;

  /** 同步当前文档路径到主进程（会话恢复 / 最近文件 / 重复打开检测的数据源） */
  setWindowPath(path: string | null): void;

  /**
   * 订阅更新下载状态（开始 / 进度 / 完成 / 取消 / 失败）。
   * 返回取消订阅函数。
   */
  onUpdateDownloadState(callback: (state: UpdateDownloadState) => void): () => void;

  /** 取消正在进行的更新下载（未在下载时无效果） */
  cancelUpdateDownload(): void;

  /** 渲染进程完成保存后请求真正关闭窗口 */
  requestForceClose(): void;

  /** 在指定窗口坐标弹出某顶级菜单的子菜单（自绘菜单栏用）；states 使对应
   * 命令项以勾选态显示（焦点模式/打字机模式/拼写检查/成对符号补全等开关） */
  popupMenu(label: string, x: number, y: number, states?: Record<string, boolean>): void;

  /**
   * 订阅主进程派发的命令（菜单/快捷键触发）。
   * 返回取消订阅函数。
   */
  onCommand(callback: (name: CommandName, payload?: unknown) => void): () => void;

  /** 在新窗口中打开指定文件 */
  openFileInNewWindow(filePath: string): void;

  /**
   * 拉取主进程为本窗口登记的“待打开”文件（文件关联/二次启动/新窗口打开/
   * 崩溃恢复/会话恢复场景），取后即删；无待打开文件返回 null。
   * restore=true 时为崩溃恢复草稿，加载后须置脏。
   */
  takePendingOpen(): Promise<PendingOpenResult | null>;

  /** 写入/更新本窗口路径对应的崩溃恢复草稿（尽力而为，无回执） */
  saveDraft(payload: { path: string; content: string }): void;

  /** 清除指定路径的崩溃恢复草稿 */
  clearDraft(path: string): void;

  /** 获取文件的绝对路径（用于拖拽文件） */
  getPathForFile(file: File): string;

  /** 读取指定路径的文件内容；失败弹错误框并返回 null */
  readFileContent(filePath: string): Promise<OpenFileResult | null>;
}
