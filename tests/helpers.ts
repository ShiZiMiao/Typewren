import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';

/* ============================================================
 * 测试公共辅助
 * 统一的应用启动 / 文档注入 / 命令注入 / 对话框打桩，
 * 避免各 spec 各自重复实现造成漂移。
 * ============================================================ */

export interface AppHandle {
  app: ElectronApplication;
  window: Page;
}

export const OUT_MAIN = `${__dirname}/../out/main/index.js`;

/** 启动测试用 Electron 实例（--test 模式：跳过关闭保护、导出直写临时目录） */
export async function launchApp(extraArgs: string[] = []): Promise<AppHandle> {
  const app = await electron.launch({ args: ['--test', OUT_MAIN, ...extraArgs] });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForSelector('.ProseMirror', { timeout: 15000 });
  // 等 Milkdown 首帧渲染与启动基线落定
  await window.waitForTimeout(600);
  return { app, window };
}

export async function closeApp(handle: AppHandle): Promise<void> {
  await handle.app.close().catch(() => {});
}

/** 经主进程注入文档内容（走 open-file-path 正常加载流程），等待渲染完成 */
export async function loadContent(handle: AppHandle, content: string, path = ''): Promise<void> {
  await handle.app.evaluate(
    ({ BrowserWindow }, payload) => {
      BrowserWindow.getAllWindows()[0].webContents.send('cmd', 'open-file-path', payload);
    },
    { path, content }
  );
  await settleContent(handle.window, content);
}

async function settleContent(window: Page, content: string): Promise<void> {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    await window.waitForSelector('.ProseMirror.is-doc-empty', { timeout: 8000 });
  } else {
    // 取首行纯文本做探针；数学/表格等节点对 textContent 不可见，探针失败时静默放行，
    // 由具体断言的轮询兜底（避免在此把整个测试挂死）。
    const firstLine = trimmed.split('\n')[0] ?? '';
    const needle = firstLine
      .replace(/[#>*`~|\[\]()$'"\\]/g, '')
      .replace(/\s+/g, '')
      .slice(0, 16);
    if (needle.length > 0) {
      try {
        await window.waitForFunction(
          (p) => {
            const el = document.querySelector('.ProseMirror');
            return el !== null && el.textContent!.includes(p);
          },
          needle,
          { timeout: 6000 }
        );
      } catch {
        // 探针不匹配（如首行含公式）：回落等待一段渲染时间
        await window.waitForTimeout(800);
      }
    }
  }
  await window.waitForTimeout(250);
}

/** 向主进程发送菜单/快捷键命令（cmd 通道） */
export function sendCommand(handle: AppHandle, name: string, payload?: unknown): Promise<void> {
  return handle.app.evaluate(
    ({ BrowserWindow }, c) => {
      BrowserWindow.getAllWindows()[0].webContents.send('cmd', c.name, c.payload);
    },
    { name, payload }
  );
}

/* ---------- 原生对话框打桩（主进程内替换 electron.dialog 方法） ---------- */

export interface DialogConfig {
  /** showSaveDialog 返回的文件路径；null = 模拟取消 */
  saveAs?: string | null;
  /** showOpenDialog 返回的文件路径；null = 模拟取消 */
  open?: string | null;
  /** showMessageBoxSync（放弃更改/关闭保护）按钮：0=保存 1=不保存 2=取消 */
  discard?: 0 | 1 | 2;
}

export function installDialogStubs(handle: AppHandle, cfg: DialogConfig = {}): Promise<void> {
  return handle.app.evaluate(({ dialog: d }, init) => {
    const g = globalThis as { __dlg: { cfg: Record<string, unknown> } };
    g.__dlg = { cfg: { saveAs: null, open: null, discard: 1, ...init } };
    const e = d as unknown as {
      showSaveDialog: (...args: unknown[]) => Promise<{ canceled: boolean; filePath?: string }>;
      showOpenDialog: (...args: unknown[]) => Promise<{ canceled: boolean; filePaths?: string[] }>;
      showMessageBoxSync: () => number;
    };
    e.showSaveDialog = async () => {
      const p = g.__dlg.cfg.saveAs as string | null;
      return p ? { canceled: false, filePath: p } : { canceled: true };
    };
    e.showOpenDialog = async () => {
      const p = g.__dlg.cfg.open as string | null;
      return p ? { canceled: false, filePaths: [p] } : { canceled: true };
    };
    e.showMessageBoxSync = () => (g.__dlg.cfg.discard as number) ?? 1;
  }, cfg);
}

export function setDialog(handle: AppHandle, cfg: Partial<DialogConfig>): Promise<void> {
  return handle.app.evaluate((_, patch) => {
    const g = globalThis as { __dlg: { cfg: Record<string, unknown> } };
    Object.assign(g.__dlg.cfg, patch);
  }, cfg);
}
