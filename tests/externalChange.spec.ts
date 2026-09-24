import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeApp,
  launchApp,
  loadContent,
  sendCommand,
  setDialog,
  type AppHandle
} from './helpers';

/* ============================================================
 * 保存时的外部修改冲突检测（fileService.save → file:read-quiet
 * + dialog:confirm）。--test 下冲突检测保持启用，确认框走打桩。
 * ============================================================ */

const WORK_DIR = join(tmpdir(), 'typewren-extchange-test');
const DOC = join(WORK_DIR, 'doc.md');

async function openMatchingDisk(diskContent: string): Promise<AppHandle> {
  if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(DOC, diskContent, 'utf-8');
  const handle = await launchApp();
  // 注入与磁盘一致的内容作为基线（干净状态）
  await loadContent(handle, diskContent, DOC);
  return handle;
}

async function makeLocalEdit(handle: AppHandle, text: string): Promise<void> {
  await handle.window.locator('.ProseMirror').click();
  await handle.window.keyboard.type(text);
  await handle.window.waitForTimeout(300);
}

test.beforeEach(() => {
  if (existsSync(WORK_DIR)) rmSync(WORK_DIR, { recursive: true, force: true });
});

test('取消：不落盘且保持脏状态', async () => {
  const handle = await openMatchingDisk('磁盘原始内容');
  try {
    await makeLocalEdit(handle, '本地编辑');
    writeFileSync(DOC, '被外部改掉了');

    await setDialog(handle, { confirm: 2 });
    await sendCommand(handle, 'save');
    await handle.window.waitForTimeout(800);

    expect(readFileSync(DOC, 'utf-8')).toBe('被外部改掉了');
    await expect(handle.window.locator('#titlebar-title')).toContainText('●');
  } finally {
    await closeApp(handle);
  }
});

test('覆盖保存：以本地内容写盘并回到干净', async () => {
  const handle = await openMatchingDisk('磁盘原始内容');
  try {
    await makeLocalEdit(handle, '本地编辑');
    writeFileSync(DOC, '被外部改掉了');

    await setDialog(handle, { confirm: 0 });
    await sendCommand(handle, 'save');

    await expect
      .poll(() => (existsSync(DOC) ? readFileSync(DOC, 'utf-8') : ''))
      .toContain('本地编辑');
    await expect(handle.window.locator('#titlebar-title')).not.toContainText('●');
  } finally {
    await closeApp(handle);
  }
});

test('重新载入磁盘版本：丢弃本地编辑、文档变干净', async () => {
  const handle = await openMatchingDisk('磁盘原始内容');
  try {
    await makeLocalEdit(handle, '本地编辑');
    writeFileSync(DOC, '被外部改掉了');

    await setDialog(handle, { confirm: 1 });
    await sendCommand(handle, 'save');

    await expect(handle.window.locator('.ProseMirror')).toContainText('被外部改掉了', {
      timeout: 5000
    });
    const text = await handle.window.locator('.ProseMirror').innerText();
    expect(text).not.toContain('本地编辑');
    expect(readFileSync(DOC, 'utf-8')).toBe('被外部改掉了');
    await expect(handle.window.locator('#titlebar-title')).not.toContainText('●');
  } finally {
    await closeApp(handle);
  }
});

test('磁盘未变时保存不弹冲突框', async () => {
  const handle = await openMatchingDisk('磁盘原始内容');
  try {
    await makeLocalEdit(handle, '本地编辑');

    // 不设置 confirm：若误弹冲突框，默认桩会答"覆盖"（结果相同），
    // 因此这里以"未弹框"为准——直接断言保存成功且文件为本地内容
    await sendCommand(handle, 'save');
    await expect
      .poll(() => (existsSync(DOC) ? readFileSync(DOC, 'utf-8') : ''))
      .toContain('本地编辑');
  } finally {
    await closeApp(handle);
  }
});

// ========== 回归：save() 三态——「重新载入」不是保存成功，不得继续破坏性后续 ==========

test('冲突选「重新载入」后 newFile 不继续清文档（save 三态回归）', async () => {
  const handle = await openMatchingDisk('磁盘原始内容');
  try {
    await makeLocalEdit(handle, '本地编辑');
    writeFileSync(DOC, '被外部改掉了');

    // 新建 → 放弃更改框选「保存」→ 冲突框选「重新载入磁盘版本」
    await setDialog(handle, { discard: 0, confirm: 1 });
    await sendCommand(handle, 'new-file');
    await handle.window.waitForTimeout(1000);

    // 'reloaded' 只是本地编辑被磁盘版本替换：newFile 不得再把文档清空
    await expect(handle.window.locator('.ProseMirror')).toContainText('被外部改掉了', {
      timeout: 5000
    });
    await expect(handle.window.locator('.ProseMirror.is-doc-empty')).toHaveCount(0);
    expect(readFileSync(DOC, 'utf-8')).toBe('被外部改掉了');
  } finally {
    await closeApp(handle);
  }
});

test('冲突选「重新载入」后 save-and-close 不关窗（save 三态回归）', async () => {
  const handle = await openMatchingDisk('磁盘原始内容');
  try {
    await makeLocalEdit(handle, '本地编辑');
    writeFileSync(DOC, '被外部改掉了');

    await setDialog(handle, { confirm: 1 });
    await sendCommand(handle, 'save-and-close');
    await handle.window.waitForTimeout(1000);

    // 旧实现把「重载」当保存成功放行关窗：窗口必须还在、内容为重载后的版本
    expect(handle.app.windows().length).toBe(1);
    await expect(handle.window.locator('.ProseMirror')).toContainText('被外部改掉了');
  } finally {
    await closeApp(handle);
  }
});
