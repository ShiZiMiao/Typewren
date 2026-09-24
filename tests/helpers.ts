import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  // 默认注入隔离 user-data-dir：--test 只关 session/drafts/关闭保护，settings.json、
  // localStorage 镜像、userData/images 仍会写真实用户目录——不隔离的话跑一遍测试
  // 就污染开发机配置（主题设置/背景图被改写）。调用方自带 --user-data-dir= 时尊重之。
  const hasUserDataDir = extraArgs.some((a) => a.startsWith('--user-data-dir='));
  const isolatedArgs = hasUserDataDir
    ? []
    : [`--user-data-dir=${mkdtempSync(join(tmpdir(), 'typewren-test-'))}`];
  const app = await electron.launch({ args: ['--test', OUT_MAIN, ...extraArgs, ...isolatedArgs] });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForSelector('.ProseMirror', { timeout: 15000 });
  // 等 Milkdown 首帧渲染与启动基线落定
  await window.waitForTimeout(600);
  const handle = { app, window };
  // 默认安装对话框打桩：新代码路径（外部修改确认等）意外触达原生弹窗时
  // 不会挂死测试；需要特定选择的用例再 setDialog 覆盖
  await installDialogStubs(handle);
  return handle;
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
            return el !== null && el.textContent!.replace(/\s+/g, '').includes(p);
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

/* ---------- 源码视图读写（#source-textarea 是 contenteditable div 的实现细节，
 * 各 spec 不要直接摸它，经此收口便于未来换回 textarea.value） ---------- */

export function readSource(handle: AppHandle): Promise<string> {
  return handle.window.evaluate(
    () => document.querySelector('#source-textarea')?.textContent ?? ''
  );
}

export function writeSource(handle: AppHandle, text: string): Promise<void> {
  return handle.window.evaluate((t) => {
    const el = document.querySelector('#source-textarea');
    if (el) el.textContent = t;
  }, text);
}

/* ---------- 原生对话框打桩（主进程内替换 electron.dialog 方法） ---------- */

export interface DialogConfig {
  /** showSaveDialog 返回的文件路径；null = 模拟取消 */
  saveAs?: string | null;
  /** showOpenDialog 返回的文件路径；null = 模拟取消 */
  open?: string | null;
  /** 关闭保护/放弃更改确认（按按钮组识别）：0=保存 1=不保存/放弃 2=取消 */
  discard?: 0 | 1 | 2;
  /** 其它通用确认框（dialog:confirm）返回的按钮下标，默认 0（第一按钮） */
  confirm?: number;
}

export function installDialogStubs(handle: AppHandle, cfg: DialogConfig = {}): Promise<void> {
  return handle.app.evaluate(({ dialog: d }, init) => {
    const g = globalThis as unknown as { __dlg: { cfg: Record<string, unknown> } };
    g.__dlg = { cfg: { saveAs: null, open: null, discard: 1, confirm: 0, ...init } };
    // 注意：本回调会被序列化到主进程执行，只能引用自身/参数内的符号
    const pick = (args: unknown[]): number => {
      const opts = (args.length > 1 ? args[1] : args[0]) as { buttons?: string[] };
      const key = (opts?.buttons ?? []).join('|');
      const isGuard = key === '保存|不保存|取消' || key === '保存|放弃更改|取消';
      const c = g.__dlg.cfg;
      return isGuard ? ((c.discard as number) ?? 1) : ((c.confirm as number) ?? 0);
    };
    const e = d as unknown as {
      showSaveDialog: (...args: unknown[]) => Promise<{ canceled: boolean; filePath?: string }>;
      showOpenDialog: (...args: unknown[]) => Promise<{ canceled: boolean; filePaths?: string[] }>;
      showMessageBoxSync: (...args: unknown[]) => number;
      showMessageBox: (...args: unknown[]) => Promise<{ response: number }>;
    };
    e.showSaveDialog = async () => {
      const p = g.__dlg.cfg.saveAs as string | null;
      return p ? { canceled: false, filePath: p } : { canceled: true };
    };
    e.showOpenDialog = async () => {
      const p = g.__dlg.cfg.open as string | null;
      return p ? { canceled: false, filePaths: [p] } : { canceled: true };
    };
    e.showMessageBoxSync = (...args: unknown[]) => pick(args);
    e.showMessageBox = async (...args: unknown[]) => ({ response: pick(args) });
  }, cfg);
}

export function setDialog(handle: AppHandle, cfg: Partial<DialogConfig>): Promise<void> {
  return handle.app.evaluate((_, patch) => {
    const g = globalThis as unknown as { __dlg: { cfg: Record<string, unknown> } };
    Object.assign(g.__dlg.cfg, patch);
  }, cfg);
}
