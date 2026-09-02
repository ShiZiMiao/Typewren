import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { readFileSync, readdirSync, promises as fsp } from 'node:fs'
import { join } from 'node:path'

import type {
  ExportDocumentPayload,
  ExportDocumentResult
} from '../shared/ipc'

/* ============================================================
 * 导出 PDF / HTML（主进程侧）
 * 渲染层已拼好完整 HTML 页面（内联样式 + KaTeX 渲染结果），
 * 这里负责：另存为对话框 → KaTeX 字体内联（自包含）→ 写盘 / 打印。
 * ============================================================ */

/** 导出对话框过滤器 */
function exportFilters(kind: ExportDocumentPayload['kind']): Electron.FileFilter[] {
  return kind === 'pdf'
    ? [{ name: 'PDF 文档', extensions: ['pdf'] }]
    : [{ name: 'HTML 文档', extensions: ['html'] }]
}

/** 对话框返回的路径未带扩展名时补全 */
function ensureExtension(
  filePath: string,
  kind: ExportDocumentPayload['kind']
): string {
  const ext = kind === 'pdf' ? '.pdf' : '.html'
  return new RegExp(`\\.${kind}$`, 'i').test(filePath)
    ? filePath
    : `${filePath}${ext}`
}

function showExportDialog(
  win: BrowserWindow | null,
  payload: ExportDocumentPayload
): Promise<Electron.SaveDialogReturnValue> {
  const options: Electron.SaveDialogOptions = {
    title: payload.kind === 'pdf' ? '导出为 PDF' : '导出为 HTML',
    defaultPath: payload.suggestedName,
    filters: exportFilters(payload.kind)
  }
  return win
    ? dialog.showSaveDialog(win, options)
    : dialog.showSaveDialog(options)
}

/** KaTeX 字体目录：dev/打包从 app 根解析，测试进程（入口在 out/ 下）回退到项目根 */
function katexFontsDir(): string | null {
  const candidates = [
    join(app.getAppPath(), 'node_modules', 'katex', 'dist', 'fonts'),
    join(process.cwd(), 'node_modules', 'katex', 'dist', 'fonts')
  ]
  for (const dir of candidates) {
    try {
      if (readdirSync(dir).length > 0) return dir
    } catch {
      // 该候选不存在，尝试下一项
    }
  }
  return null
}

/**
 * 把导出页内 KaTeX 的 url(fonts/…) 引用替换为 base64 data URI，
 * 并移除 woff/ttf 冗余段（仅保留 woff2），使导出的 HTML/PDF 自包含、离线可渲染。
 * 字体目录不可用时原样返回（公式退回系统字体兜底）。
 */
function embedKatexFonts(html: string): string {
  const fontsDir = katexFontsDir()
  if (!fontsDir) return html
  const available = new Set(readdirSync(fontsDir))

  let result = html.replace(
    /url\(fonts\/([A-Za-z0-9_.-]+\.woff2)\)/g,
    (match, name: string) => {
      if (!available.has(name)) return match
      const font = readFileSync(join(fontsDir, name)).toString('base64')
      return `url(data:font/woff2;base64,${font})`
    }
  )
  // 去掉已内联的 woff2 之外的冗余源（两轮覆盖 woff→ttf 的链式引用）
  const dropLegacy =
    /\s*,?\s*url\(fonts\/[A-Za-z0-9_.-]+\.(?:woff|ttf)\)\s*format\((?:'[^']*'|"[^"]*")\),?/g
  result = result.replace(dropLegacy, '')
  result = result.replace(dropLegacy, '')
  return result
}

/** 把完整 HTML 打印成 PDF：临时文件 → 隐藏窗口 → printToPDF → 写盘 */
async function printHtmlToPdf(html: string, destPath: string): Promise<void> {
  const tempDir = await fsp.mkdtemp(join(app.getPath('temp'), 'typewren-export-'))
  let printWin: BrowserWindow | null = null
  try {
    const tempHtml = join(tempDir, 'export.html')
    await fsp.writeFile(tempHtml, html, 'utf-8')

    printWin = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    await printWin.loadFile(tempHtml)
    const pdf = await printWin.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true
    })
    await fsp.writeFile(destPath, pdf)
  } finally {
    printWin?.destroy()
    await fsp.rm(tempDir, { recursive: true, force: true })
  }
}

/** 注册导出 IPC：弹另存为对话框并完成 HTML 写盘 / PDF 打印 */
export function registerExportHandlers(): void {
  ipcMain.handle(
    'export:document',
    async (event, payload: ExportDocumentPayload): Promise<ExportDocumentResult> => {
      const win = BrowserWindow.fromWebContents(event.sender)

      // 测试模式跳过系统对话框，直接写入临时目录（供 e2e 断言导出产物）
      const destPath = process.argv.includes('--test')
        ? join(
            app.getPath('temp'),
            payload.kind === 'pdf' ? 'typewren-export-test.pdf' : 'typewren-export-test.html'
          )
        : await pickExportPath(win, payload)
      if (!destPath) return { ok: false, canceled: true }

      try {
        const html = embedKatexFonts(payload.html)
        if (payload.kind === 'pdf') {
          await printHtmlToPdf(html, destPath)
        } else {
          await fsp.writeFile(destPath, html, 'utf-8')
        }
        return { ok: true }
      } catch (error) {
        const label = payload.kind === 'pdf' ? 'PDF' : 'HTML'
        dialog.showErrorBox('导出失败', `${label} 导出失败：\n${String(error)}`)
        return { ok: false, error: String(error) }
      }
    }
  )
}

/** 弹原生另存为对话框；取消返回 null */
async function pickExportPath(
  win: BrowserWindow | null,
  payload: ExportDocumentPayload
): Promise<string | null> {
  const dialogResult = await showExportDialog(win, payload)
  if (dialogResult.canceled || !dialogResult.filePath) return null
  return ensureExtension(dialogResult.filePath, payload.kind)
}