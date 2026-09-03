import type { Editor } from '@milkdown/kit/core';

import type { TypewrenApi } from '../env.d';
import { isImageFile } from '../../../shared/ipc';
import { insertMarkdown } from '../editor/actions';
import type { FileService } from './fileService';

/* ============================================================
 * 图片粘贴 / 拖拽落盘（渲染层侧）
 * 判断图片来源后委托主进程保存到文档 assets 目录，
 * 生成的路径按 Typora 习惯以相对 Markdown 引用插入编辑器：
 *   ![](./assets/image-20260901-103000-1234.png)
 * 截图/网络图片无源路径：渲染层读完字节转 base64 再保存。
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

/** 取路径的目录部分（兼容 / 与 \\，渲染层不依赖 node:path） */
function dirnamePath(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx < 0 ? p : p.slice(0, idx);
}

/** fromDir 目录下的相对路径；不在其下时返回原绝对路径（兜底） */
function relativeTo(fromDir: string, target: string): string {
  const from = normalizePath(fromDir).replace(/\/+$/, '');
  const to = normalizePath(target);
  return to.startsWith(`${from}/`) ? to.slice(from.length + 1) : to;
}

/**
 * 图片粘贴 / 拖拽落盘（渲染层侧）
 * 判断图片来源后 → 主进程保存到文档 assets 目录，
 * 生成的路径按文档内习惯以相对 Markdown 插入编辑器：
 *   ![](./assets/image-20260901-100000-1234.png)
 * 截图/网络位图无源文件路径 → 渲染层转 base64 后保存。
 */
export class ImageService {
  constructor(
    private readonly api: TypewrenApi,
    private readonly editor: Editor,
    private readonly fileService: FileService
  ) {}

  /** 当前文档绝对路径（主进程据此推导同目录 assets 落盘）；未保存为 null */
  private docPath(): string | null {
    return this.fileService.getFilePath();
  }

  /** 绝对保存路径 → Markdown 引用（文档内相对路径优先） */
  private markdownSrc(savedPath: string): string {
    const docPath = this.fileService.getFilePath();
    if (!docPath) return encodeURI(savedPath);
    const rel = relativeTo(dirnamePath(docPath), savedPath);
    return `./${encodeURI(rel)}`;
  }

  private insertImage(src: string): void {
    insertMarkdown(this.editor, `![](${src})`);
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
    if (result.ok && result.savedPath) this.insertImage(this.markdownSrc(result.savedPath));
  }

  /* ---------- 内部实现 ---------- */

  private async insertFromPath(srcPath: string): Promise<void> {
    const result = await this.api.saveImageFromPath({
      srcPath,
      docPath: this.docPath()
    });
    if (result.ok && result.savedPath) this.insertImage(this.markdownSrc(result.savedPath));
  }

  private async insertFromData(file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await this.api.saveImageFromData({
      base64: bytesToBase64(bytes),
      mime: file.type || 'image/png',
      docPath: this.docPath()
    });
    if (result.ok && result.savedPath) this.insertImage(this.markdownSrc(result.savedPath));
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
