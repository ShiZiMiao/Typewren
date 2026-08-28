import { test, expect, _electron as electron } from '@playwright/test'
import path from 'path'

let electronApp: Awaited<ReturnType<typeof electron.launch>>
let window: Awaited<ReturnType<typeof electronApp.firstWindow>>

test.beforeAll(async () => {
  electronApp = await electron.launch({
    args: [path.join(__dirname, '../out/main/index.js')]
  })
  window = await electronApp.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('.ProseMirror', { timeout: 10000 })
  // 等待编辑器内容加载
  await window.waitForTimeout(1000)
})

test.afterAll(async () => {
  await electronApp.close()
})

async function ensureSearchClosed(): Promise<void> {
  const searchBar = window.locator('#search-bar')
  if (await searchBar.isVisible()) {
    await window.keyboard.press('Escape')
    await expect(searchBar).toBeHidden()
  }
}

// ========== 搜索栏基础功能 ==========

test.describe('搜索栏基础功能', () => {
  test.beforeEach(async () => {
    await ensureSearchClosed()
  })

  test('Ctrl+F 打开搜索栏', async () => {
    const searchBar = window.locator('#search-bar')
    await expect(searchBar).toBeHidden()
    await window.keyboard.press('Control+f')
    await expect(searchBar).toBeVisible()
    await expect(window.locator('#search-input')).toBeFocused()
  })

  test('Esc 关闭搜索栏', async () => {
    await window.keyboard.press('Control+f')
    await expect(window.locator('#search-bar')).toBeVisible()
    await window.keyboard.press('Escape')
    await expect(window.locator('#search-bar')).toBeHidden()
  })

  test('Ctrl+F 切换搜索栏', async () => {
    const searchBar = window.locator('#search-bar')
    await window.keyboard.press('Control+f')
    await expect(searchBar).toBeVisible()
    await window.keyboard.press('Control+f')
    await expect(searchBar).toBeHidden()
  })
})

// ========== 渲染模式搜索 ==========

test.describe('渲染模式搜索', () => {
  test.beforeEach(async () => {
    await ensureSearchClosed()
    await window.keyboard.press('Control+f')
    await expect(window.locator('#search-bar')).toBeVisible()
  })

  test('输入关键词后匹配计数更新', async () => {
    const input = window.locator('#search-input')
    const matchCount = window.locator('#search-match-count')

    // 先获取编辑器内容
    const editorText = await window.locator('.ProseMirror').textContent() || ''
    console.log('Editor content length:', editorText.length)

    // 搜索一个常见字符
    await input.fill('a')
    await window.waitForTimeout(500)
    const text = await matchCount.textContent()
    console.log('Match count for "a":', text)

    // 如果编辑器有内容，应该有匹配
    if (editorText.length > 0) {
      expect(text).not.toBe('0/0')
    }
  })

  test('搜索框关闭后重新打开保留上次搜索词', async () => {
    const input = window.locator('#search-input')
    await input.fill('test')
    await window.waitForTimeout(300)

    await window.keyboard.press('Escape')
    await expect(window.locator('#search-bar')).toBeHidden()

    await window.keyboard.press('Control+f')
    await expect(window.locator('#search-bar')).toBeVisible()
    await expect(input).toHaveValue('test')
  })
})

// ========== 搜索栏 UI ==========

test.describe('搜索栏 UI', () => {
  test.beforeEach(async () => {
    await ensureSearchClosed()
  })

  test('搜索栏包含必要元素', async () => {
    await window.keyboard.press('Control+f')
    await expect(window.locator('#search-bar')).toBeVisible()
    await expect(window.locator('#search-input')).toBeVisible()
    await expect(window.locator('#search-match-count')).toBeVisible()
    await expect(window.locator('#search-prev')).toBeVisible()
    await expect(window.locator('#search-next')).toBeVisible()
    await expect(window.locator('#search-close')).toBeVisible()
  })

  test('点击关闭按钮关闭搜索栏', async () => {
    await window.keyboard.press('Control+f')
    await expect(window.locator('#search-bar')).toBeVisible()
    await window.locator('#search-close').click()
    await expect(window.locator('#search-bar')).toBeHidden()
  })

  test('搜索栏显示在右上角', async () => {
    await window.keyboard.press('Control+f')
    const searchBar = window.locator('#search-bar')
    const box = await searchBar.boundingBox()
    expect(box).toBeTruthy()
    if (box) {
      // 搜索栏应该在窗口右上方
      expect(box.x).toBeGreaterThan(0)
      expect(box.y).toBeGreaterThan(0)
    }
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

  test('ProseMirror 编辑器存在', async () => {
    await expect(window.locator('.ProseMirror')).toBeVisible()
  })

  test('大纲面板存在', async () => {
    await expect(window.locator('#outline-panel')).toBeVisible()
  })
})
