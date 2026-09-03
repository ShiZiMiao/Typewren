/* ============================================================
 * preload 暴露的 API 契约（单一来源）
 * preload/index.ts 实现它，渲染层 env.d.ts 引用它——两端不再各自声明，
 * 避免新增方法时一侧漏改导致类型漂移。
 * ============================================================ */

import type {
  CommandName,
  ExportDocumentPayload,
  ExportDocumentResult,
  FileContentPayload,
  ImageDownloadPayload,
  ImageSaveFromDataPayload,
  ImageSaveFromPathPayload,
  ImageSaveResult,
  OpenFileResult,
  SaveAsPayload,
  SaveAsResult
} from './ipc';

export interface TypewrenApi {
  readonly platform: NodeJS.Platform;

  /** 弹出原生打开对话框，读取文件内容；取消或失败返回 null */
  openFileDialog(): Promise<OpenFileResult | null>;

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

  /** 渲染进程完成保存后请求真正关闭窗口 */
  requestForceClose(): void;

  /** 在指定窗口坐标弹出某顶级菜单的子菜单（自绘菜单栏用） */
  popupMenu(label: string, x: number, y: number): void;

  /**
   * 订阅主进程派发的命令（菜单/快捷键触发）。
   * 返回取消订阅函数。
   */
  onCommand(callback: (name: CommandName, payload?: unknown) => void): () => void;

  /** 在新窗口中打开指定文件 */
  openFileInNewWindow(filePath: string): void;

  /** 获取文件的绝对路径（用于拖拽文件） */
  getPathForFile(file: File): string;

  /** 读取指定路径的文件内容；失败弹错误框并返回 null */
  readFileContent(filePath: string): Promise<OpenFileResult | null>;
}
