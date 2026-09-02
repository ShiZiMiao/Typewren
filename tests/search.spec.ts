import { test, expect, _electron as electron } from '@playwright/test'
import path from 'path'

let electronApp: Awaited<ReturnType<typeof electron.launch>>
let window: Awaited<ReturnType<typeof electronApp.firstWindow>>

test.beforeAll(async () => {
  electronApp = await electron.launch({
    args: ['--test', path.join(__dirname, '../out/main/index.js')]
  })
  window = await electronApp.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('.ProseMirror', { timeout: 10000 })
  await window.waitForTimeout(1000)
})

test.afterAll(async () => {
  await electronApp.close()
})

async function ensureSearchClosed(): Promise<void> {
  const searchBar = window.locator('#search-bar')
  if (await searchBar.isVisible()) {
    // Ctrl+F 切换关闭搜索栏（Escape 只在输入框有焦点时生效）
    await window.keyboard.press('Control+f')
    await expect(searchBar).toBeHidden()
  }
}

async function setEditorContent(text: string): Promise<void> {
  await window.locator('.ProseMirror').click()
  await window.keyboard.press('Control+a')
  await window.keyboard.press('Delete')
  await window.waitForTimeout(200)
  await window.keyboard.type(text)
  await window.waitForTimeout(300)
}

// ========== 搜索功能 ==========

test.describe('搜索功能', () => {
  test.beforeEach(async () => {
    await ensureSearchClosed()
  })

  test('搜索匹配计数正确', async () => {
    await setEditorContent('hello world hello test hello')
    await window.keyboard.press('Control+f')
    await window.locator('#search-input').fill('hello')
    await window.waitForTimeout(500)
    await expect(window.locator('#search-match-count')).toHaveText('1/3')
  })

  test('Enter 导航下一个', async () => {
    await setEditorContent('hello world hello test hello')
    await window.keyboard.press('Control+f')
    await window.locator('#search-input').fill('hello')
    await window.waitForTimeout(500)
    await expect(window.locator('#search-match-count')).toHaveText('1/3')

    await window.locator('#search-input').click()
    await window.keyboard.press('Enter')
    await window.waitForTimeout(300)
    await expect(window.locator('#search-match-count')).toHaveText('2/3')

    await window.keyboard.press('Enter')
    await window.waitForTimeout(300)
    await expect(window.locator('#search-match-count')).toHaveText('3/3')

    await window.keyboard.press('Enter')
    await window.waitForTimeout(300)
    await expect(window.locator('#search-match-count')).toHaveText('1/3')
  })

  test('Shift+Enter 导航上一个', async () => {
    await setEditorContent('hello world hello test hello')
    await window.keyboard.press('Control+f')
    await window.locator('#search-input').fill('hello')
    await window.waitForTimeout(500)

    await window.locator('#search-input').click()
    await window.keyboard.press('Shift+Enter')
    await window.waitForTimeout(300)
    await expect(window.locator('#search-match-count')).toHaveText('3/3')
  })

  test('点击按钮导航', async () => {
    await setEditorContent('hello world hello test hello')
    await window.keyboard.press('Control+f')
    await window.locator('#search-input').fill('hello')
    await window.waitForTimeout(500)

    await window.locator('#search-next').click()
    await window.waitForTimeout(300)
    await expect(window.locator('#search-match-count')).toHaveText('2/3')

    await window.locator('#search-prev').click()
    await window.waitForTimeout(300)
    await expect(window.locator('#search-match-count')).toHaveText('1/3')
  })
})

// ========== 替换功能 ==========

test.describe('替换功能', () => {
  test.beforeEach(async () => {
    await ensureSearchClosed()
  })

  test('Ctrl+H 打开替换面板', async () => {
    await setEditorContent('test')
    await window.keyboard.press('Control+h')
    await expect(window.locator('#search-bar')).toBeVisible()
    await expect(window.locator('#replace-row')).toBeVisible()
    await expect(window.locator('#replace-input')).toBeVisible()
  })

  test('替换当前匹配', async () => {
    await setEditorContent('hello world hello test hello')
    await window.keyboard.press('Control+h')
    await window.locator('#search-input').fill('hello')
    await window.locator('#replace-input').fill('hi')
    await window.waitForTimeout(500)

    await expect(window.locator('#search-match-count')).toHaveText('1/3')

    await window.locator('#btn-replace').click()
    await window.waitForTimeout(500)

    const text = await window.locator('.ProseMirror').textContent()
    expect(text).toBe('hi world hello test hello')
  })

  test('全部替换', async () => {
    await setEditorContent('hello world hello test hello')
    await window.keyboard.press('Control+h')
    await window.locator('#search-input').fill('hello')
    await window.locator('#replace-input').fill('hi')
    await window.waitForTimeout(500)

    await window.locator('#btn-replace-all').click()
    await window.waitForTimeout(500)

    const text = await window.locator('.ProseMirror').textContent()
    expect(text).toBe('hi world hi test hi')
  })

  test('替换撤销', async () => {
    await setEditorContent('hello world hello test hello')
    await window.keyboard.press('Control+h')
    await window.locator('#search-input').fill('hello')
    await window.locator('#replace-input').fill('hi')
    await window.waitForTimeout(500)

    await window.locator('#btn-replace').click()
    await window.waitForTimeout(500)

    let text = await window.locator('.ProseMirror').textContent()
    expect(text).toBe('hi world hello test hello')

    await window.locator('.ProseMirror').click()
    await window.keyboard.press('Control+z')
    await window.waitForTimeout(500)

    text = await window.locator('.ProseMirror').textContent()
    expect(text).toBe('hello world hello test hello')
  })

  test('全部替换撤销', async () => {
    await setEditorContent('hello world hello test hello')
    await window.keyboard.press('Control+h')
    await window.locator('#search-input').fill('hello')
    await window.locator('#replace-input').fill('hi')
    await window.waitForTimeout(500)

    await window.locator('#btn-replace-all').click()
    await window.waitForTimeout(500)

    let text = await window.locator('.ProseMirror').textContent()
    expect(text).toBe('hi world hi test hi')

    await window.locator('.ProseMirror').click()
    await window.keyboard.press('Control+z')
    await window.waitForTimeout(500)

    text = await window.locator('.ProseMirror').textContent()
    expect(text).toBe('hello world hello test hello')
  })
})

// ========== 布局 ==========

test.describe('布局', () => {
  test('标题栏存在', async () => {
    await expect(window.locator('#titlebar')).toBeVisible()
  })

  test('菜单栏存在', async () => {
    await expect(window.locator('#menubar')).toBeVisible()
  })

  test('编辑区存在', async () => {
    await expect(window.locator('#editor-container')).toBeVisible()
  })

  test('状态栏存在', async () => {
    await expect(window.locator('#status-bar')).toBeVisible()
  })
})

// ========== 搜索扩展（补充用例） ==========

test.describe('搜索扩展', () => {
  test.beforeEach(async () => {
    await ensureSearchClosed()
  })

  test('无匹配显示 0/0', async () => {
    await setEditorContent('ababab')
    await window.keyboard.press('Control+f')
    await window.locator('#search-input').fill('zzz不存在')
    await window.waitForTimeout(500)
    await expect(window.locator('#search-match-count')).toHaveText('0/0')
  })

  test('跨段内容匹配', async () => {
    await setEditorContent('第一段内容 hello\n\n第二段 hello world')
    await window.keyboard.press('Control+f')
    await window.locator('#search-input').fill('hello')
    await window.waitForTimeout(500)
    await expect(window.locator('#search-match-count')).toHaveText('1/2')
  })

  test('替换后文档置脏', async () => {
    await setEditorContent('hello world')
    await window.keyboard.press('Control+h')
    await window.locator('#search-input').fill('hello')
    await window.locator('#replace-input').fill('hi')
    await window.waitForTimeout(500)
    await window.locator('#btn-replace').click()
    await window.waitForTimeout(300)
    await expect(window.locator('#titlebar-title')).toContainText('●')
  })

  test('Esc 关闭搜索栏且不破坏文档', async () => {
    await setEditorContent('hello world')
    await window.keyboard.press('Control+f')
    await window.locator('#search-input').fill('hello')
    await window.waitForTimeout(300)
    await window.locator('#search-input').press('Escape')
    await expect(window.locator('#search-bar')).toBeHidden()
    await expect(window.locator('.ProseMirror')).toContainText('hello world')
  })
})
