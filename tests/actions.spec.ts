import { test, expect } from '@playwright/test'
import {
  launchApp,
  closeApp,
  loadContent,
  sendCommand,
  stubPrompts,
  type AppHandle
} from './helpers'

let app: AppHandle

test.beforeAll(async () => {
  app = await launchApp()
})

test.afterAll(async () => {
  await closeApp(app)
})

test.describe('格式命令（cmd 通道直达 actions）', () => {
  test('加粗切换：全选→加粗→取消', async () => {
    await loadContent(app, '需要加粗的文字内容')
    await app.window.locator('.ProseMirror').click()
    await app.window.keyboard.press('Control+a')
    await app.window.waitForTimeout(200)
    await sendCommand(app, 'format:bold')
    await expect(app.window.locator('.ProseMirror strong')).toHaveCount(1)

    await sendCommand(app, 'format:bold')
    await expect(app.window.locator('.ProseMirror strong')).toHaveCount(0)
  })

  test('斜体 / 删除线 / 行内代码切换', async () => {
    await loadContent(app, '待格式化内容')
    await app.window.locator('.ProseMirror').click()
    await app.window.keyboard.press('Control+a')

    await sendCommand(app, 'format:italic')
    await expect(app.window.locator('.ProseMirror em')).toHaveCount(1)

    await sendCommand(app, 'format:strike')
    await expect(app.window.locator('.ProseMirror del')).toHaveCount(1)

    await sendCommand(app, 'format:inline-code')
    await expect(app.window.locator('.ProseMirror code')).toHaveCount(1)
  })

  test('标题层级设置与还原正文', async () => {
    await loadContent(app, '普通段落')
    await app.window.locator('.ProseMirror').click()

    for (const level of [1, 2, 3, 4, 5, 6]) {
      await sendCommand(app, 'heading', level)
      await expect(app.window.locator(`.ProseMirror h${level}`)).toHaveCount(1)
      await sendCommand(app, 'heading', 0)
      await expect(app.window.locator('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6')).toHaveCount(0)
    }
  })

  test('无序列表包裹', async () => {
    await loadContent(app, '列表项内容')
    await app.window.locator('.ProseMirror').click()

    await sendCommand(app, 'list:bullet')
    await expect(app.window.locator('.ProseMirror ul')).toHaveCount(1)
  })

  test('有序列表包裹', async () => {
    await loadContent(app, '列表项内容')
    await app.window.locator('.ProseMirror').click()

    await sendCommand(app, 'list:number')
    await expect(app.window.locator('.ProseMirror ol')).toHaveCount(1)
  })

  test('插入任务列表', async () => {
    await loadContent(app, '')
    await app.window.locator('.ProseMirror').click()
    await sendCommand(app, 'list:task')
    await expect(
      app.window.locator('.ProseMirror li[data-item-type="task"]')
    ).toHaveCount(1, { timeout: 5000 })
  })

  test('引用块包裹', async () => {
    await loadContent(app, '引用内容')
    await app.window.locator('.ProseMirror').click()
    await sendCommand(app, 'block:quote')
    await expect(app.window.locator('.ProseMirror blockquote')).toHaveCount(1)
    await expect(app.window.locator('.ProseMirror blockquote')).toContainText('引用内容')
  })

  test('已有引用块上再次包裹会嵌套一层', async () => {
    await loadContent(app, '引用内容')
    await app.window.locator('.ProseMirror').click()
    await sendCommand(app, 'block:quote')
    await sendCommand(app, 'block:quote')
    await expect(app.window.locator('.ProseMirror blockquote')).toHaveCount(2)
  })

  test('插入代码块（无语言）', async () => {
    await loadContent(app, '')
    await app.window.locator('.ProseMirror').click()
    await sendCommand(app, 'block:code')
    const pre = app.window.locator('.ProseMirror pre')
    await expect(pre).toHaveCount(1, { timeout: 5000 })
  })

  test('插入水平线', async () => {
    await loadContent(app, '')
    await app.window.locator('.ProseMirror').click()
    await sendCommand(app, 'insert:hr')
    await expect(app.window.locator('.ProseMirror hr')).toHaveCount(1, { timeout: 5000 })
  })

  test('插入链接（prompt 打桩）', async () => {
    await loadContent(app, '')
    await stubPrompts(app, ['https://example.com/doc', '示例文档'])
    await app.window.locator('.ProseMirror').click()
    await sendCommand(app, 'format:link')
    await expect(
      app.window.locator('.ProseMirror a[href="https://example.com/doc"]')
    ).toHaveCount(1, { timeout: 5000 })
  })

  test('选中文本加链接', async () => {
    await loadContent(app, '这里有个链接')
    await app.window.locator('.ProseMirror').click()
    await app.window.keyboard.press('Control+a')
    await stubPrompts(app, ['https://example.com/link'])
    await sendCommand(app, 'format:link')
    await expect(app.window.locator('.ProseMirror a[href="https://example.com/link"]')).toHaveCount(1)
  })

  test('插入图片', async () => {
    await loadContent(app, '')
    await stubPrompts(app, ['https://example.com/pic.png', '说明文字'])
    await app.window.locator('.ProseMirror').click()
    await sendCommand(app, 'format:image')
    await expect(
      app.window.locator('.ProseMirror img[src="https://example.com/pic.png"]')
    ).toHaveCount(1, { timeout: 5000 })
  })

  test('撤销（history 插件）', async () => {
    await loadContent(app, '撤销测试文本')
    await app.window.locator('.ProseMirror').click()
    await app.window.keyboard.press('Control+a')
    await app.window.waitForTimeout(200)
    await sendCommand(app, 'format:bold')
    await expect(app.window.locator('.ProseMirror strong')).toHaveCount(1)

    await app.window.locator('.ProseMirror').click()
    await app.window.keyboard.press('Control+z')
    await app.window.waitForTimeout(200)
    await expect(app.window.locator('.ProseMirror strong')).toHaveCount(0)
  })

test('重做（Ctrl+Shift+Z）', async () => {
    await loadContent(app, '初始文本')
    await app.window.locator('.ProseMirror').click()
    await app.window.keyboard.type(' 追加内容')
    await app.window.waitForTimeout(300)
    await expect(app.window.locator('.ProseMirror')).toContainText('追加内容')

    await app.window.locator('.ProseMirror').click()
    await app.window.waitForTimeout(200)
    await app.window.keyboard.press('Control+z')
    await app.window.waitForTimeout(300)
    await expect(app.window.locator('.ProseMirror')).not.toContainText('追加内容')

    await app.window.locator('.ProseMirror').click()
    await app.window.waitForTimeout(200)
    await app.window.keyboard.press('Control+Shift+z')
    await app.window.waitForTimeout(800)
    await expect(app.window.locator('.ProseMirror')).toContainText('追加内容', {
      timeout: 8000
    })
  })
})