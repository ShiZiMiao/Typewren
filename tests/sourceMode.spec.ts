import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  launchApp,
  closeApp,
  loadContent,
  sendCommand,
  installDialogStubs,
  setDialog,
  type AppHandle
} from './helpers'

let app: AppHandle

const WORK_DIR = join(tmpdir(), 'typewren-src-test')
const SAVE_PATH = join(WORK_DIR, 'src-doc.md')

test.beforeAll(async () => {
  if (existsSync(WORK_DIR)) rmSync(WORK_DIR, { recursive: true, force: true })
  mkdirSync(WORK_DIR, { recursive: true })
  app = await launchApp()
  await installDialogStubs(app, { saveAs: null, open: null, discard: 1 })
})

test.afterAll(async () => {
  await closeApp(app)
})

/** 把源码模式切到指定状态（幂等：先查当前激活态再切换） */
async function setSourceMode(activate: boolean): Promise<void> {
  const active = await app.window
    .locator('#app')
    .evaluate((el) => el.classList.contains('source-mode'))
  if (active !== activate) {
    await sendCommand(app, 'view:source')
    await app.window.waitForTimeout(200)
  }
  if (activate) {
    await expect(app.window.locator('#source-textarea')).toBeVisible({ timeout: 5000 })
  }
}

test.describe('源码模式', () => {
  test('切换进入 / 退出', async () => {
    await loadContent(app, '# 标题\n\n正文段落')
    await setSourceMode(true)
    await expect(app.window.locator('#editor')).toBeHidden()

    await setSourceMode(false)
    await expect(app.window.locator('#source-textarea')).toBeHidden({ timeout: 5000 })
  })

  test('源码内容与渲染序列化一致', async () => {
    await loadContent(app, '# 一级标题\n\n**加粗** 与 `代码`')
    await setSourceMode(true)
    const src = await app.window.locator('#source-textarea').textContent()
    expect(src).toContain('# 一级标题')
    expect(src).toContain('**加粗**')
    expect(src).toContain('`代码`')
    await setSourceMode(false)
  })

  test('源码编辑 → 置脏 → 切回渲染同步', async () => {
    await loadContent(app, '# 原标题')
    await setSourceMode(true)

    // 在源码中改标题
    await app.window.locator('#source-textarea').fill('# 源码改过的标题\n')
    await app.window.waitForTimeout(300)
    await expect(app.window.locator('#titlebar-title')).toContainText('●')

    await setSourceMode(false)
    await expect(app.window.locator('.ProseMirror h1')).toHaveText('源码改过的标题', {
      timeout: 5000
    })
  })

  test('源码模式下保存内容正确', async () => {
    await loadContent(app, '', '')
    await setSourceMode(true)
    await app.window.locator('#source-textarea').fill('# 源码保存\n\n段落')
    await app.window.waitForTimeout(300)

    setDialog(app, { saveAs: SAVE_PATH })
    await sendCommand(app, 'save')
    await expect
      .poll(() => (existsSync(SAVE_PATH) ? readFileSync(SAVE_PATH, 'utf-8') : null))
      .toContain('# 源码保存')

    await setSourceMode(false)
  })

  test('源码模式下打开新文档同步刷新（onContentReplaced）', async () => {
    await setSourceMode(true)
    await loadContent(app, '# 新文档标题\n\n新内容', '')
    // 打开新文档后源码视图应与新文档一致
    const src = await app.window.locator('#source-textarea').textContent()
    expect(src).toContain('# 新文档标题')
    await setSourceMode(false)
  })

  test('Tab 键不跳出编辑区（冒烟）', async () => {
    await loadContent(app, '行首文本')
    await setSourceMode(true)
    const ta = app.window.locator('#source-textarea')
    await ta.click()
    // Tab 不应把焦点移出源码编辑器
    await app.window.keyboard.press('Tab')
    await app.window.waitForTimeout(200)
    const focused = await app.window.evaluate(() => {
      return document.activeElement === document.querySelector('#source-textarea')
    })
    expect(focused).toBe(true)
    await setSourceMode(false)
  })
})