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

// ========== 表格显示测试 ==========

test.describe('表格显示', () => {
  test('编辑器存在', async () => {
    const editor = window.locator('.ProseMirror')
    await expect(editor).toBeVisible()
  })

  test('表格样式变量存在', async () => {
    const hasTableStyles = await window.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      return {
        hasBorder: style.getPropertyValue('--border-strong') !== '',
        hasTableHeadBg: style.getPropertyValue('--table-head-bg') !== ''
      }
    })

    expect(hasTableStyles.hasBorder).toBeTruthy()
    expect(hasTableStyles.hasTableHeadBg).toBeTruthy()
  })

  test('编辑器overflow-x设置正确', async () => {
    const overflowX = await window.locator('.ProseMirror').evaluate((el) => {
      return getComputedStyle(el).overflowX
    })

    // 应该是auto或scroll
    expect(['auto', 'scroll']).toContain(overflowX)
  })

  test('编辑器宽度自适应', async () => {
    const editor = window.locator('.ProseMirror')
    const editorBox = await editor.boundingBox()

    expect(editorBox).toBeTruthy()
    if (editorBox) {
      // 编辑器宽度应该大于0
      expect(editorBox.width).toBeGreaterThan(0)
      // 编辑器高度应该大于0
      expect(editorBox.height).toBeGreaterThan(0)
    }
  })

  test('编辑器可滚动', async () => {
    // 清空编辑器
    await window.locator('.ProseMirror').click()
    await window.keyboard.press('Control+a')
    await window.keyboard.press('Delete')
    await window.waitForTimeout(200)

    // 输入多行内容
    for (let i = 0; i < 50; i++) {
      await window.keyboard.type(`Line ${i + 1}: This is a test line with some content`)
      await window.keyboard.press('Enter')
    }
    await window.waitForTimeout(500)

    // 检查编辑器容器是否可以纵向滚动
    const editorContainer = window.locator('#editor-container')
    await expect(editorContainer).toBeVisible()

    const hasVerticalScroll = await editorContainer.evaluate((el) => {
      return el.scrollHeight > el.clientHeight
    })

    expect(hasVerticalScroll).toBeTruthy()
  })
})
