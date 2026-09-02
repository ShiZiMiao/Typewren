import { test, expect } from '@playwright/test'
import {
  launchApp,
  closeApp,
  loadContent,
  sendCommand,
  type AppHandle
} from './helpers'

let app: AppHandle

test.beforeAll(async () => {
  app = await launchApp()
})

test.afterAll(async () => {
  await closeApp(app)
})

/** 读取渲染视图序列化结果：进入源码模式取 textarea 内容（等价 getMarkdown） */
async function serializedMarkdown(): Promise<string> {
  await sendCommand(app, 'view:source')
  const text = await app.window.locator('#source-textarea').textContent()
  await sendCommand(app, 'view:source')
  return text ?? ''
}

// ========== 编辑器渲染 ==========

test.describe('编辑器渲染', () => {
  test('标题 1-6 级渲染', async () => {
    await loadContent(
      app,
      '# 一级\n\n## 二级\n\n### 三级\n\n#### 四级\n\n##### 五级\n\n###### 六级'
    )
    for (let level = 1; level <= 6; level++) {
      await expect(app.window.locator(`.ProseMirror h${level}`)).toHaveCount(1)
    }
  })

  test('行内格式渲染', async () => {
    await loadContent(
      app,
      '**加粗** *斜体* ~~删除线~~ `行内代码` [链接](https://example.com)'
    )
    await expect(app.window.locator('.ProseMirror strong')).toHaveCount(1)
    await expect(app.window.locator('.ProseMirror em')).toHaveCount(1)
    await expect(app.window.locator('.ProseMirror del')).toHaveCount(1)
    await expect(app.window.locator('.ProseMirror code')).toHaveCount(1)
    await expect(app.window.locator('.ProseMirror a[href="https://example.com"]')).toHaveCount(1)
  })

  test('三类列表渲染', async () => {
    await loadContent(
      app,
      '- 无序一\n- 无序二\n\n1. 有序一\n2. 有序二\n\n- [x] 已完成\n- [ ] 未完成'
    )
    await expect(app.window.locator('.ProseMirror ul')).toHaveCount(2)
    await expect(app.window.locator('.ProseMirror ol')).toHaveCount(1)
    await expect(
      app.window.locator('.ProseMirror li[data-item-type="task"]')
    ).toHaveCount(2)
    await expect(
      app.window.locator('.ProseMirror li[data-item-type="task"][data-checked="true"]')
    ).toHaveCount(1)
  })

  test('引用块渲染', async () => {
    await loadContent(app, '> 引用内容')
    await expect(app.window.locator('.ProseMirror blockquote')).toHaveCount(1)
    await expect(app.window.locator('.ProseMirror blockquote')).toContainText('引用内容')
  })

  test('代码块高亮渲染', async () => {
    await loadContent(
      app,
      '```typescript\nconst answer: number = 42\nconsole.log(answer)\n```'
    )
    const pre = app.window.locator('.ProseMirror pre')
    await expect(pre).toHaveCount(1)
    await expect(pre.locator('code')).toHaveCount(1)
    // 语法高亮由 prosemirror-highlight 以行内 span 装饰（语言标签写在装饰里）
    await expect(pre.locator('.hljs-keyword')).toHaveCount(1, { timeout: 10000 })
  })

  test('数学公式渲染（行内 + 块级）', async () => {
    await loadContent(
      app,
      '行内公式 $x^2 + y^2 = z^2$ 与块级公式：\n\n$$\n\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}\n$$'
    )
    await expect(app.window.locator('.typewren-math-inline .katex')).toHaveCount(1)
    await expect(app.window.locator('.typewren-math-block .katex')).toHaveCount(1)
  })

  test('水平线渲染', async () => {
    await loadContent(app, '上方\n\n---\n\n下方')
    await expect(app.window.locator('.ProseMirror hr')).toHaveCount(1)
  })

  test('空文档显示占位状态', async () => {
    await loadContent(app, '')
    await expect(app.window.locator('.ProseMirror.is-doc-empty')).toBeVisible({ timeout: 5000 })
  })

  test('序列化往返：渲染 → 源码一致', async () => {
    const md =
      '# 标题\n\n**加粗** 与 [链接](https://x.com)\n\n- 列表项\n\n```js\nconst a = 1\n```'
    await loadContent(app, md)

    const src = await serializedMarkdown()
    expect(src).toContain('# 标题')
    expect(src).toContain('**加粗**')
    expect(src).toContain('[链接](https://x.com)')
    // 序列化对无序列表使用 * 前缀（Gfm 编辑器序列化行为）
    expect(src).toContain('* 列表项')
    expect(src).toContain('```js')
  })

  test('中文与特殊字符不损坏', async () => {
    await loadContent(app, '中文内容 <tag> &amp; "引号" \'单引号\'\n\n`code<>&`')
    const src = await serializedMarkdown()
    expect(src).toContain('中文内容')
    expect(src).toContain('<tag>')
    expect(src).toContain('code<>&')
  })
})

// ========== 任务列表 ==========

test.describe('任务列表', () => {
  test('勾选热区点击翻转任务', async () => {
    await loadContent(app, '- [ ] 待办事项')
    const task = app.window.locator('.ProseMirror li[data-item-type="task"]').first()
    await expect(task).toHaveAttribute('data-checked', 'false')

    // 左侧 30px 勾选框热区
    await task.click({ position: { x: 8, y: 10 } })
    await expect(task).toHaveAttribute('data-checked', 'true', { timeout: 5000 })

    // 序列化同步为 [x]（序列化对任务列表使用 * 前缀，匹配记号即可）
    const src = await serializedMarkdown()
    expect(src).toMatch(/\[x\] 待办事项/)
    expect(src).not.toMatch(/\[ \] 待办事项/)
  })

  test('点击非热区不翻转', async () => {
    await loadContent(app, '- [ ] 待办任务')
    const li = app.window.locator('.ProseMirror li[data-item-type="task"]').first()
    await li.click({ position: { x: 120, y: 10 } })
    await app.window.waitForTimeout(300)
    await expect(li).toHaveAttribute('data-checked', 'false')
  })
})

// ========== 数学公式输入 ==========

test.describe('数学公式输入', () => {
  test('输入 $..$ 触发行内公式输入规则', async () => {
    await loadContent(app, '')
    await app.window.locator('.ProseMirror').click()
    await app.window.keyboard.type('公式 $\\alpha$ 测试')
    await expect(
      app.window.locator('.typewren-math-inline .katex')
    ).toHaveCount(1, { timeout: 5000 })

    const src = await serializedMarkdown()
    expect(src).toContain('\\alpha')
  })

  test('插入空块级公式并提交 LaTeX', async () => {
    await loadContent(app, '下方文本段落')
    await app.window.locator('.ProseMirror').click()
    await sendCommand(app, 'block:math')

    const editorEl = app.window.locator('.typewren-math-block .math-src-editor')
    await expect(editorEl).toBeVisible({ timeout: 5000 })
    await editorEl.fill('\\frac{1}{2}')
    await editorEl.press('Escape')
    // 点击文本段落取消公式选中态，节点退出编辑态渲染 KaTeX
    await app.window.locator('.ProseMirror p').first().click({ position: { x: 8, y: 8 } })

    await expect(
      app.window.locator('.typewren-math-block .math-rendered .katex')
    ).toBeVisible({ timeout: 5000 })

    const src = await serializedMarkdown()
    expect(src).toContain('\\frac{1}{2}')
  })

  test('插入行内公式：Enter 提交', async () => {
    await loadContent(app, '段落文本')
    await app.window.locator('.ProseMirror').click()
    await sendCommand(app, 'block:math-inline')

    const editorEl = app.window.locator('.typewren-math-inline .math-src-editor')
    await expect(editorEl).toBeVisible({ timeout: 5000 })
    await editorEl.fill('E=mc^2')
    await editorEl.press('Enter')
    // 点击文本取消选中态后渲染
    await app.window.locator('.ProseMirror p').click({ position: { x: 8, y: 8 } })

    await expect(
      app.window.locator('.typewren-math-inline .math-rendered .katex')
    ).toBeVisible({ timeout: 5000 })
  })
})