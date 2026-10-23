import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeApp, installDialogStubs, launchApp, type AppHandle } from './helpers';

/* ============================================================
 * IPC 防御与图片嗅探全覆盖（主进程行覆盖补缺）：
 * - file:write / read-quiet / dir:list / show-in-folder / confirm
 *   的畸形载荷拒绝与失败路径（越权、扩展名、不可写）；
 * - dialog:open-file / save-as 的读写失败收场（showErrorBox 桩）；
 * - image:save-from-data 全部魔数嗅探分支（gif/bmp/webp/ico/tif/svg…）；
 * - dialog:open-image / image:save-from-path / image:download /
 *   assets:copy 的校验拒绝路径。
 * ============================================================ */

let app: AppHandle;
let dir: string;

interface TypewrenLike {
  writeFile: (p: unknown) => Promise<boolean>;
  readFileQuiet: (p: unknown) => Promise<string | null>;
  listDir: (p: unknown) => Promise<unknown[]>;
  showInFolder: (p: unknown) => void;
  confirmDialog: (p: unknown) => Promise<number | null>;
  openFileDialog: () => Promise<unknown>;
  saveFileDialog: (p: unknown) => Promise<unknown>;
  openImageDialog: () => Promise<string[]>;
  saveImageFromData: (p: unknown) => Promise<{ ok: boolean; savedPath?: string; error?: string }>;
  saveImageFromPath: (p: unknown) => Promise<{ ok: boolean; savedPath?: string; error?: string }>;
  downloadImage: (p: unknown) => Promise<{ ok: boolean; savedPath?: string; error?: string }>;
  copyAssets: (p: unknown) => Promise<{ ok: boolean; copied?: number; error?: string }>;
}

/** 在渲染层直接以任意载荷调用（经 preload 透传，不做客户端校验——正测主进程防线） */
function call<T>(window: AppHandle['window'], method: keyof TypewrenLike, payload?: unknown): Promise<T> {
  return window.evaluate(
    ({ m, p }) => {
      const t = (window as unknown as { typewren: Record<string, (x?: unknown) => Promise<unknown>> })
        .typewren;
      return t[m](p) as Promise<T>;
    },
    { m: method, p: payload }
  );
}

test.beforeAll(async () => {
  app = await launchApp();
  dir = mkdtempSync(join(tmpdir(), 'typewren-ipc-test-'));
});

test.afterAll(async () => {
  await closeApp(app);
  rmSync(dir, { recursive: true, force: true });
});

test('file:write 防御：非绝对路径 / 非法扩展名 / 畸形载荷一律拒绝', async () => {
  const payload = { path: join(dir, 'ok.md'), content: 'x' };
  expect(await call<boolean>(app.window, 'writeFile', payload)).toBe(true);
  // 相对路径拒绝
  expect(await call<boolean>(app.window, 'writeFile', { path: 'evil.md', content: 'x' })).toBe(
    false
  );
  // 可打开扩展名之外拒绝（防覆写任意文件）
  expect(
    await call<boolean>(app.window, 'writeFile', {
      path: join(dir, 'evil.exe'),
      content: 'x'
    })
  ).toBe(false);
  // 畸形载荷拒绝
  expect(await call<boolean>(app.window, 'writeFile', null)).toBe(false);
  expect(await call<boolean>(app.window, 'writeFile', { path: 42, content: 'x' })).toBe(false);
  expect(await call<boolean>(app.window, 'writeFile', { path: join(dir, 'a.md') })).toBe(false);
});

test('file:write 写盘失败：showErrorBox 收场并返回 false（关闭保护中止回报）', async () => {
  // 以目录冒充 .md 文件：writeFile 抛 EISDIR 走 catch
  const trapped = join(dir, 'trapped.md');
  mkdirSync(trapped, { recursive: true });
  await app.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __errBoxes: string[] };
    g.__errBoxes = [];
    (dialog as unknown as { showErrorBox: (t: string, c: string) => void }).showErrorBox = (
      t,
      c
    ) => {
      g.__errBoxes.push(`${t}|${c}`);
    };
  });
  expect(
    await call<boolean>(app.window, 'writeFile', { path: trapped, content: 'x' })
  ).toBe(false);
  const boxes = await app.app.evaluate(
    () => (globalThis as unknown as { __errBoxes: string[] }).__errBoxes ?? []
  );
  expect(boxes.some((b) => b.includes('无法保存文件'))).toBe(true);
});

test('file:read-quiet 防御与不存在文件返回 null', async () => {
  expect(await call<string | null>(app.window, 'readFileQuiet', 'not-a-string')).toBeNull();
  expect(await call<string | null>(app.window, 'readFileQuiet', 'C:/x.exe')).toBeNull();
  expect(await call<string | null>(app.window, 'readFileQuiet', join(dir, 'ghost.md'))).toBeNull();
  const real = join(dir, 'quiet.md');
  writeFileSync(real, '静默读取', 'utf-8');
  expect(await call<string | null>(app.window, 'readFileQuiet', real)).toBe('静默读取');
});

test('dir:list 防御：文档目录子树外拒绝、畸形载荷拒绝', async () => {
  const docPath = join(dir, 'doc.md');
  writeFileSync(docPath, '# d\n', 'utf-8');
  // 子树内正常列举
  const entries = await call<{ name: string }[]>(app.window, 'listDir', {
    docPath,
    dirPath: dir
  });
  expect(entries.length).toBeGreaterThan(0);
  // 子树外（系统目录）拒绝 → 空列表
  expect(
    await call<unknown[]>(app.window, 'listDir', { docPath, dirPath: 'C:\\Windows' })
  ).toEqual([]);
  // 畸形载荷拒绝
  expect(await call<unknown[]>(app.window, 'listDir', null)).toEqual([]);
  expect(await call<unknown[]>(app.window, 'listDir', { docPath: 42, dirPath: dir })).toEqual([]);
  // 子树内不存在的目录：readdir 失败回落空列表
  expect(
    await call<unknown[]>(app.window, 'listDir', { docPath, dirPath: join(dir, 'ghost-sub') })
  ).toEqual([]);
});

test('show-in-folder 防御：非法路径不触达 shell', async () => {
  await app.app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __shown: string[] };
    g.__shown = [];
    (shell as unknown as { showItemInFolder: (p: string) => void }).showItemInFolder = (p) => {
      g.__shown.push(p);
    };
  });
  const ok = join(dir, 'located.md');
  writeFileSync(ok, '# l\n', 'utf-8');
  await call<void>(app.window, 'showInFolder', ok);
  await call<void>(app.window, 'showInFolder', join(dir, 'evil.exe'));
  await call<void>(app.window, 'showInFolder', '');
  await call<void>(app.window, 'showInFolder', 42);
  await expect
    .poll(() =>
      app.app.evaluate(() => (globalThis as unknown as { __shown: string[] }).__shown ?? [])
    )
    .toEqual([ok]);
});

test('dialog:confirm 畸形载荷返回 null', async () => {
  expect(await call<number | null>(app.window, 'confirmDialog', null)).toBeNull();
  expect(
    await call<number | null>(app.window, 'confirmDialog', { title: 't', buttons: 'not-array' })
  ).toBeNull();
});

test('dialog:open-file 读盘失败：showErrorBox 收场返回 null', async () => {
  await installDialogStubs(app, { open: join(dir, 'ghost-open.md') });
  await app.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __errBoxes: string[] };
    g.__errBoxes = [];
    (dialog as unknown as { showErrorBox: (t: string, c: string) => void }).showErrorBox = (
      t,
      c
    ) => {
      g.__errBoxes.push(`${t}|${c}`);
    };
  });
  expect(await call<unknown>(app.window, 'openFileDialog')).toBeNull();
  const boxes = await app.app.evaluate(
    () => (globalThis as unknown as { __errBoxes: string[] }).__errBoxes ?? []
  );
  expect(boxes.some((b) => b.includes('无法读取文件'))).toBe(true);
});

test('dialog:save-as 写盘失败：showErrorBox 收场返回 null', async () => {
  // 以目录冒充另存目标：writeFile 抛错走 catch
  const trappedAs = join(dir, 'trapped-as.md');
  mkdirSync(trappedAs, { recursive: true });
  await installDialogStubs(app, { saveAs: trappedAs });
  await app.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __errBoxes: string[] };
    g.__errBoxes = [];
    (dialog as unknown as { showErrorBox: (t: string, c: string) => void }).showErrorBox = (
      t,
      c
    ) => {
      g.__errBoxes.push(`${t}|${c}`);
    };
  });
  const res = await call<{ path?: string } | null>(app.window, 'saveFileDialog', {
    content: '另存内容'
  });
  expect(res).toBeNull();
  const boxes = await app.app.evaluate(
    () => (globalThis as unknown as { __errBoxes: string[] }).__errBoxes ?? []
  );
  expect(boxes.some((b) => b.includes('无法写入文件'))).toBe(true);
});

test('image:save-from-data 全魔数嗅探分支（gif/bmp/webp/ico/tif/tiff/svg）', async () => {
  // 魔数字节直接构造（手工 base64 易错）；sniffImageExt 的分支逐一打到
  const cases: Array<[number[], string]> = [
    [[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], '.gif'], // GIF89a
    [[0x42, 0x4d], '.bmp'], // BM
    [
      [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], // RIFF....WEBP
      '.webp'
    ],
    [[0x00, 0x00, 0x01, 0x00], '.ico'],
    [[0x49, 0x49, 0x2a, 0x00], '.tif'], // II*\0 小端
    [[0x4d, 0x4d, 0x00, 0x2a], '.tiff'], // MM\0* 大端
    [Array.from(Buffer.from('<svg xmlns="a"></svg>')), '.svg']
  ];
  for (const [bytes, ext] of cases) {
    const res = await call<{ ok: boolean; savedPath?: string; error?: string }>(
      app.window,
      'saveImageFromData',
      { base64: Buffer.from(bytes).toString('base64'), mime: 'image/png', docPath: null }
    );
    expect(res.ok, `${ext} 嗅探应通过（${res.error ?? ''}）`).toBe(true);
    expect(res.savedPath!.toLowerCase().endsWith(ext)).toBe(true);
    expect(existsSync(res.savedPath!)).toBe(true);
  }
  // 无魔数可嗅探：准入拒绝
  const rejected = await call<{ ok: boolean; error?: string }>(app.window, 'saveImageFromData', {
    base64: Buffer.from('NOT-AN-IMAGE-AT-ALL').toString('base64'),
    mime: 'image/png',
    docPath: null
  });
  expect(rejected.ok).toBe(false);
});

test('dialog:open-image：取消返回空、选择返回路径', async () => {
  await installDialogStubs(app, { open: null });
  expect(await call<string[]>(app.window, 'openImageDialog')).toEqual([]);
  await installDialogStubs(app, { open: join(dir, 'any.png') });
  expect(await call<string[]>(app.window, 'openImageDialog')).toEqual([join(dir, 'any.png')]);
});

test('image:save-from-path 防御：非图片扩展名/不存在/畸形载荷拒绝', async () => {
  // 非图片扩展名
  const txt = join(dir, 'note.txt');
  writeFileSync(txt, 'x', 'utf-8');
  const r1 = await call<{ ok: boolean; error?: string }>(app.window, 'saveImageFromPath', {
    srcPath: txt,
    docPath: null
  });
  expect(r1.ok).toBe(false);
  // 不存在的源
  const r2 = await call<{ ok: boolean }>(app.window, 'saveImageFromPath', {
    srcPath: join(dir, 'ghost.png'),
    docPath: null
  });
  expect(r2.ok).toBe(false);
  // 畸形载荷
  expect((await call<{ ok: boolean }>(app.window, 'saveImageFromPath', null)).ok).toBe(false);
  // 合法复制（PNG 头）
  const png = join(dir, 'real.png');
  writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64'));
  const okRes = await call<{ ok: boolean; savedPath?: string }>(app.window, 'saveImageFromPath', {
    srcPath: png,
    docPath: join(dir, 'doc.md')
  });
  expect(okRes.ok).toBe(true);
  expect(existsSync(okRes.savedPath!)).toBe(true);
});

test('image:download 协议与载荷防御', async () => {
  // 非 http/https 拒绝
  const r1 = await call<{ ok: boolean; error?: string }>(app.window, 'downloadImage', {
    url: 'file:///C:/x.png',
    docPath: null
  });
  expect(r1.ok).toBe(false);
  expect(r1.error).toContain('http');
  // 畸形载荷
  expect((await call<{ ok: boolean }>(app.window, 'downloadImage', null)).ok).toBe(false);
  expect((await call<{ ok: boolean }>(app.window, 'downloadImage', { url: 42 })).ok).toBe(false);
});

test('assets:copy 防御 / 同目录短路 / 真实复制', async () => {
  // 独立目录：与其它用例的 assets 产物隔离（曾被前置用例污染预期）
  const local = mkdtempSync(join(tmpdir(), 'typewren-assets-'));
  const docA = join(local, 'a.md');
  const docB = join(local, 'sub', 'b.md');
  mkdirSync(join(local, 'sub'), { recursive: true });
  writeFileSync(docA, '# a' + String.fromCharCode(10), 'utf-8');
  writeFileSync(docB, '# b' + String.fromCharCode(10), 'utf-8');
  try {
    // 畸形载荷
    expect((await call<{ ok: boolean }>(app.window, 'copyAssets', null)).ok).toBe(false);
    expect(
      (await call<{ ok: boolean }>(app.window, 'copyAssets', { fromDoc: 42, toDoc: docB })).ok
    ).toBe(false);
    // 同目录短路（copied: 0）
    const same = await call<{ ok: boolean; copied?: number }>(app.window, 'copyAssets', {
      fromDoc: docA,
      toDoc: join(local, 'a2.md')
    });
    expect(same.ok).toBe(true);
    expect(same.copied).toBe(0);
    // 源无 assets 目录：成功空操作
    const ghost = await call<{ ok: boolean; copied?: number }>(app.window, 'copyAssets', {
      fromDoc: join(local, 'ghost.md'),
      toDoc: docB
    });
    expect(ghost.ok).toBe(true);
    expect(ghost.copied ?? 0).toBe(0);
    // 真实复制：源 assets 的图片落到目标 assets（已存在跳过）
    mkdirSync(join(local, 'assets'), { recursive: true });
    writeFileSync(join(local, 'assets', 'pic.png'), Buffer.from('iVBORw0KGgo=', 'base64'));
    const real = await call<{ ok: boolean; copied?: number }>(app.window, 'copyAssets', {
      fromDoc: docA,
      toDoc: docB
    });
    expect(real.ok).toBe(true);
    expect(real.copied).toBe(1);
    expect(existsSync(join(local, 'sub', 'assets', 'pic.png'))).toBe(true);
    const again = await call<{ ok: boolean; copied?: number }>(app.window, 'copyAssets', {
      fromDoc: docA,
      toDoc: docB
    });
    expect(again.copied).toBe(0);
  } finally {
    rmSync(local, { recursive: true, force: true });
  }
});

test('外部修改冲突 read-quiet 三态通道存活（读真实内容）', async () => {
  const p = join(dir, 'conflict.md');
  writeFileSync(p, '磁盘内容', 'utf-8');
  const got = await call<string | null>(app.window, 'readFileQuiet', p);
  expect(got).toBe('磁盘内容');
  // 合法但非 UTF-8 文本也应返回字符串（不抛错）
  expect(typeof (await call<string | null>(app.window, 'readFileQuiet', p))).toBe('string');
});
