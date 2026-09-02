import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OUT_MAIN, launchApp } from './helpers'

/* ============================================================
 * 启动参数与单实例（index.ts extractMarkdownPath / second-instance）
 * ============================================================ */

const WORK_DIR = join(tmpdir(), 'typewren-argv-test')
const DOC_A = join(WORK_DIR, 'argv-a.md')
const DOC_B = join(WORK_DIR, 'argv-b.md')

function createDoc(filePath: string, heading: string): void {
  mkdirSync(WORK_DIR, { recursive: true })
  writeFileSync(filePath, `# ${heading}\n\n正文内容`, 'utf-8')
}

test.beforeAll(() => {
  if (existsSync(WORK_DIR)) rmSync(WORK_DIR, { recursive: true, force: true })
  mkdirSync(WORK_DIR, { recursive: true })
})

test('命令行参数打开 Markdown 文件', async () => {
  createDoc(DOC_A, '命令行打开的文档')
  const app = await electron.launch({ args: ['--test', OUT_MAIN, DOC_A] })
  const window = await app.firstWindow()
  try {
    await window.waitForLoadState('domcontentloaded')
    await window.waitForSelector('.ProseMirror', { timeout: 15000 })
    await expect(window.locator('.ProseMirror h1')).toHaveText('命令行打开的文档', {
      timeout: 10000
    })
  } finally {
    await app.close().catch(() => {})
  }
})

test('二次启动实例把文件交给首实例（second-instance 接线）', async () => {
  createDoc(DOC_A, '首实例文档')
  const first = await launchApp()
  try {
    await first.app.evaluate(({ BrowserWindow }, p) => {
      BrowserWindow.getAllWindows()[0].webContents.send('cmd', 'open-file-path', p)
    }, {
      path: DOC_A,
      content: readFileSync(DOC_A, 'utf-8')
    })
    await expect(first.window.locator('.ProseMirror h1')).toHaveText('首实例文档', {
      timeout: 5000
    })

    // 真实二次启动会因单实例锁立即退出（Playwright 视为异常），
    // 这里在主进程内人工派发 second-instance 事件验证处理链路由。
    createDoc(DOC_B, '二次启动传递的文档')
    await first.app.evaluate(({ app }, argv) => {
      app.emit('second-instance', {} as Electron.Event, argv)
    }, [
      process.execPath,
      '--test',
      OUT_MAIN,
      DOC_B
    ])

    // 首实例应聚焦并加载第二份文档
    await expect(first.window.locator('.ProseMirror h1')).toHaveText(
      '二次启动传递的文档',
      { timeout: 15000 }
    )
  } finally {
    await first.app.close().catch(() => {})
  }
})