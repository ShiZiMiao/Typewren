import type { Editor } from '@milkdown/kit/core';

import type { TypewrenApi } from '../../../shared/typewren-api';
import { isImageFile } from '../../../shared/ipc';
import { insertMarkdown } from '../editor/actions';
import type { FileService } from './fileService';

/* ============================================================
 * 图片粘贴 / 拖拽落盘（渲染层侧）
 * 判断图片来源后委托主进程保存到文档 assets 目录，生成的路径以
 * 相对 Markdown 引用插入编辑器（截图/网络图片无源路径：渲染层读完
 * 字节转 base64 再保存；URL 图片由主进程下载）：
 *   ![](./assets/image-20260901-103000-1234.png)
 * 落盘失败一律弹框反馈（主进程 failResult 只回错误不弹框，静默失败
 * 用户无从知道图没插进去）。插入走 actions.insertMarkdown：源码模式下
 * 自动改插源码视图（退出源码时被写回覆盖而丢失的历史坑）。
 * ============================================================ */

/** 剪贴板位图可能高达数 MB，分块拼 string 避免栈溢出 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Windows 路径分隔符统一归一化（仅渲染层本地的字符串处理） */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * 取路径的目录部分（兼容 / 与 \\，渲染层不依赖 node:path）。
 * 无分隔符（纯文件名）返回 ''——旧实现返回整个文件名，把它当目录用。
 * 注意：本函数是通用工具，只因历史位置暂住图片服务（main.ts 跨层引用，
 * 勿挪走而不留同名转发）。
 */
export function dirnamePath(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx < 0 ? '' : p.slice(0, idx);
}

/** fromDir 目录下的相对路径；不在其下时返回原绝对路径（兜底） */
function relativeTo(fromDir: string, target: string): string {
  const from = normalizePath(fromDir).replace(/\/+$/, '');
  const to = normalizePath(target);
  // Windows 路径大小写不敏感：前缀判定忽略大小写（盘符/目录大小写不一致时
  // 否则相对化失败，Markdown 里落一个绝对路径），切片仍按原串长度
  if (to.length > from.length + 1 && to.toLowerCase().startsWith(`${from}/`.toLowerCase())) {
    return to.slice(from.length + 1);
  }
  return to;
}

/**
 * Markdown 引用里的路径编码：encodeURI 不转义 ( ) # ? —— 文件名/目录带括号
 * （非配对）会把 ![x](…a(1).png) 的引用解析打断，带 # ? 在 URL 层面会被当
 * fragment/query。手动补百分号编码（在 encodeURI 之后做，不重复编码 %）。
 * 解码端是 editor/imageView.decodeImageRef（resolveImageSrc 不解码），
 * 两端必须成对演进——只编码不解析会让落盘文件永远 404。
 */
function encodeMarkdownPath(p: string): string {
  return encodeURI(p).replace(/[()#?]/g, (ch) => {
    return `%${ch.charCodeAt(0).toString(16).toUpperCase()}`;
  });
}

export class ImageService {
  constructor(
    private readonly api: TypewrenApi,
    private readonly editor: Editor,
    private readonly fileService: FileService
  ) {}

  /** 当前文档绝对路径（主进程据此推导同目录 assets 落盘）；未保存为 null：
   *  空串一并归 null（open-file-path 空路径的窗口也是"未保存"语义，
   *  主进程 validDocPath 只收 null 或绝对路径） */
  private docPath(): string | null {
    return this.fileService.getFilePath() || null;
  }

  /** 绝对保存路径 → Markdown 引用（文档内相对路径优先） */
  private markdownSrc(savedPath: string): string {
    const docPath = this.fileService.getFilePath();
    // 未保存文档：正斜杠绝对路径（必须转正斜杠——反斜杠经 encodeURI
    // 变 %5C 后既污染 Markdown 又会被解析成未知协议，正是"粘贴不显示"的老坑）
    if (!docPath) return encodeMarkdownPath(normalizePath(savedPath));
    const rel = relativeTo(dirnamePath(docPath), savedPath);
    return `./${encodeMarkdownPath(rel)}`;
  }

  private insertImage(src: string): void {
    insertMarkdown(this.editor, `![](${src})`);
  }

  /**
   * 落盘失败反馈：主进程只回错误串不弹框，静默失败会让用户以为"粘贴没反应"
   * （图片根本没落盘）。统一用单按钮原生框（与另存为附件复制失败同款）。
   */
  private reportFailure(action: string, error: string | undefined): void {
    void this.api.confirmDialog({
      message: `${action}失败`,
      detail: error ?? '未知错误',
      buttons: ['知道了']
    });
  }

  /* ---------- 入口 ---------- */

  /** 粘贴/拖拽的图片文件列表 → 保存并逐个插入 */
  async insertFiles(files: readonly File[]): Promise<void> {
    for (const file of files) {
      if (!isImageFile(file)) continue;
      // 有真实路径（从资源管理器复制/拖拽）→ 直接复制文件；
      // 无路径（截图/网页位图）→ 读字节转 base64
      const sourcePath = this.api.getPathForFile(file);
      if (sourcePath) {
        await this.insertFromPath(sourcePath);
      } else {
        await this.insertFromData(file);
      }
    }
  }

  /** 网络图片 URL → 下载本地化 */
  async insertFromUrl(url: string): Promise<void> {
    const result = await this.api.downloadImage({ url, docPath: this.docPath() });
    if (result.ok && result.savedPath) {
      this.insertImage(this.markdownSrc(result.savedPath));
    } else {
      this.reportFailure('插入网络图片', result.error);
    }
  }

  /** 菜单「插入图片」：原生文件选择框（多选）→ 逐个按粘贴同款流程落盘并插入 */
  async pickAndInsertLocally(): Promise<void> {
    const paths = await this.api.openImageDialog();
    if (!paths || paths.length === 0) return;
    for (const path of paths) {
      await this.insertFromPath(path);
    }
  }

  /* ---------- 内部实现 ---------- */

  private async insertFromPath(srcPath: string): Promise<void> {
    const result = await this.api.saveImageFromPath({
      srcPath,
      docPath: this.docPath()
    });
    if (result.ok && result.savedPath) {
      this.insertImage(this.markdownSrc(result.savedPath));
    } else {
      this.reportFailure('插入图片', result.error);
    }
  }

  private async insertFromData(file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await this.api.saveImageFromData({
      base64: bytesToBase64(bytes),
      mime: file.type || 'image/png',
      docPath: this.docPath()
    });
    if (result.ok && result.savedPath) {
      this.insertImage(this.markdownSrc(result.savedPath));
    } else {
      this.reportFailure('插入图片', result.error);
    }
  }
}

/* ============================================================
 * 事件接入：粘贴（PM handlePaste）与拖放（document drop）。
 * 返回 true 表示事件已被吞掉，不再触发默认行为。
 * ============================================================ */

/** 从纯文本里提取单条图片 URL（支持 [text](url) 包装），否则返回 null */
function extractImageUrl(text: string): string | null {
  const line = text.trim().split(/\r?\n/)[0] ?? '';
  if (!line || line.length > 2048) return null;
  const inner = line.match(/^!?\[[^\]]*\]\(([^)]+)\)$/)?.[1] ?? line;
  const url = inner.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const path = url.split(/[?#]/)[0];
  return /\.(?:png|jpe?g|gif|webp|svg)$/i.test(path) ? url : null;
}

/** 处理粘贴：文件型图片 → 剪贴板位图 → 纯图片 URL，三类皆落盘后插入 */
export function handleImagePaste(service: ImageService, event: ClipboardEvent): boolean {
  const dt = event.clipboardData;
  if (!dt) return false;

  // 1. 文件型图片（文件管理器复制，携带真实路径）
  const files = Array.from(dt.files).filter(isImageFile);
  if (files.length > 0) {
    event.preventDefault();
    void service.insertFiles(files);
    return true;
  }

  // 2. 剪贴板位图（截图 / 网页图片复制，无路径）
  const imageItem = Array.from(dt.items).find((item) => item.type.startsWith('image/'));
  if (imageItem) {
    const file = imageItem.getAsFile();
    if (file) {
      event.preventDefault();
      void service.insertFiles([file]);
      return true;
    }
  }

  // 3. 纯图片 URL 文本 → 下载本地化
  const url = extractImageUrl(dt.getData('text/plain'));
  if (url) {
    event.preventDefault();
    void service.insertFromUrl(url);
    return true;
  }

  return false;
}

/** 处理拖放：图片文件或网络图片 URL 拖入编辑区 */
export function handleImageDrop(service: ImageService, event: DragEvent): boolean {
  const dt = event.dataTransfer;
  if (!dt) return false;

  const files = Array.from(dt.files).filter(isImageFile);
  if (files.length > 0) {
    event.preventDefault();
    event.stopPropagation();
    void service.insertFiles(files);
    return true;
  }

  const url = extractImageUrl(dt.getData('text/uri-list') || dt.getData('text/plain'));
  if (url) {
    event.preventDefault();
    event.stopPropagation();
    void service.insertFromUrl(url);
    return true;
  }

  return false;
}
