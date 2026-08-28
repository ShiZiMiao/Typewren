/* ============================================================
 * Typewren 渲染进程入口
 * 装配顺序：样式 → 布局骨架 → 编辑器 → UI 组件 → 命令路由
 * ============================================================ */

import '@milkdown/kit/prose/view/style/prosemirror.css'
import '@milkdown/kit/prose/tables/style/tables.css'
import '@milkdown/kit/prose/gapcursor/style/gapcursor.css'
import 'katex/dist/katex.min.css'

import './styles/variables.css'
import './styles/layout.css'
import './styles/editor.css'
import './styles/widgets.css'

import { createEditor } from '@/editor/createEditor'
import {
  insertHr,
  insertImage,
  insertMathBlock,
  insertOrUpdateLink,
  insertTable,
  insertTaskItem,
  makeCodeBlock,
  setHeadingLevel,
  toggleBlockquote,
  toggleTextMark,
  wrapInListKind,
  insertMathInline
} from '@/editor/actions'
import { buildLayout } from '@/ui/layout'
import {
  activeHeadingIndex,
  createOutlinePanel
} from '@/ui/outlinePanel'
import { SourceModeController } from '@/ui/sourceMode'
import { updateStatusBar } from '@/ui/statusBar'
import { initThemeToggle, toggleTheme } from '@/ui/theme'
import { createSearchBar } from '@/ui/searchBar'
import { FileService } from '@/services/fileService'

const WELCOME_MARKDOWN = `# 欢迎使用 Typewren

单栏**所见即所得**：输入 Markdown 语法立即渲染，光标移开后只留下排版结果。

## 快速上手

- 输入 \`# \`` + ` 空格` + ` 把当前行变为标题
- **加粗** 用 \`**\`，*斜体* 用 \`*\`，~~删除线~~ 用 \`~~\`
- 输入 \`- \`、\`1. \`、\`- [ ] \` 创建三种列表
- 输入 \`$$\` 后敲空格，插入数学公式块
- 访问 [Milkdown](https://milkdown.dev) 了解编辑器内核

## 待办示例

- [x] 打开 Typewren
- [ ] 试试勾选这个任务

## 表格示例

| 功能 | 状态 |
| --- | --- |
| 行列操作按钮 | 光标进入表格时出现 |

## 代码高亮

\`\`\`typescript
export function greet(name: string): string {
  return \`你好, \${name}!\`
}
\`\`\`

## 数学公式

行内公式 $e^{i\\pi} + 1 = 0$ 与块级公式：

$$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
$$

> 按 Ctrl+O 打开 .md 文件，Ctrl+S 保存。
`

function debounce<T extends (...args: never[]) => void>(
  fn: T,
  waitMs: number
): (...args: Parameters<T>) => void {
  let timer: number | undefined
  return (...args: Parameters<T>) => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => fn(...args), waitMs)
  }
}

async function bootstrap(): Promise<void> {
  const layout = buildLayout(document.getElementById('app-root')!)

  /* ---------- 主题 ---------- */
  initThemeToggle(layout.btnThemeToggle)

  /* ---------- 自绘菜单栏：点击顶级项弹出原生子菜单 ---------- */
  layout.menubar
    .querySelectorAll<HTMLButtonElement>('.menubar-item')
    .forEach((btn) => {
      btn.addEventListener('click', () => {
        const rect = btn.getBoundingClientRect()
        window.typewren.popupMenu(
          btn.dataset.label ?? '',
          rect.left,
          rect.bottom
        )
        btn.classList.add('open')
        window.setTimeout(() => btn.classList.remove('open'), 800)
      })
    })

  /* ---------- 大纲面板折叠状态 ---------- */
  const OUTLINE_KEY = 'typewren.outline-collapsed'
  let outlineCollapsed = localStorage.getItem(OUTLINE_KEY) === '1'

  const applyOutlineState = (): void => {
    layout.app.classList.toggle('outline-collapsed', outlineCollapsed)
    layout.btnOutlineToggle.textContent = outlineCollapsed ? '☰ 大纲' : '☰ 大纲'
    localStorage.setItem(OUTLINE_KEY, outlineCollapsed ? '1' : '0')
  }
  applyOutlineState()

  const toggleOutlinePanel = (): void => {
    outlineCollapsed = !outlineCollapsed
    applyOutlineState()
  }

  layout.btnOutlineToggle.addEventListener('click', toggleOutlinePanel)

  document.querySelector('#outline-panel button')?.addEventListener('click', () => {
    outlineCollapsed = true
    applyOutlineState()
  })

  /* ---------- 创建编辑器 ---------- */
  // 先建占位服务引用，编辑器回调里再取值（避免初始化时序问题）
  let fileService!: FileService
  let outline!: ReturnType<typeof createOutlinePanel>
  let sourceMode!: SourceModeController

  const refreshStatusBar = (): void => {
    updateStatusBar(instance.editor, layout, sourceMode.getSourceState())
  }

  const refreshOutline = debounce(() => {
    outline.refresh()

    // 光标所在标题联动高亮
    const total = layout.outlineTree.querySelectorAll('.outline-item').length
    if (total > 0) {
      outline.setActive(activeHeadingIndex(instance.editor, total))
    } else {
      outline.setActive(null)
    }
  }, 120)

  /* ---------- 首次启动显示欢迎页，之后空白 ---------- */
  const WELCOME_SEEN_KEY = 'typewren.welcome-seen'
  const isFirstLaunch = !localStorage.getItem(WELCOME_SEEN_KEY)
  if (isFirstLaunch) localStorage.setItem(WELCOME_SEEN_KEY, '1')

  const instance = await createEditor({
    root: layout.editorHost,
    initialMarkdown: isFirstLaunch ? WELCOME_MARKDOWN : '',
    onMarkdownUpdated: () => fileService.handleDocUpdated(),
    onViewChanged: () => {
      refreshStatusBar()
      refreshOutline()
    }
  })

  /* ---------- 初始化各模块 ---------- */
  fileService = new FileService(window.typewren, instance.editor)
  fileService.onTitleChange = (title) => {
    layout.titlebarTitle.textContent = title
  }
  sourceMode = new SourceModeController(
    instance.editor,
    fileService,
    layout.app,
    layout.sourceTextarea,
    layout.btnSourceToggle,
    refreshStatusBar
  )
  outline = createOutlinePanel(instance.editor, layout.outlineTree)

  /* ---------- 搜索栏 ---------- */
  const searchBar = createSearchBar(
    layout.searchBarContainer,
    () => sourceMode.isActive,
    () => layout.sourceTextarea
  )

  outline.refresh()
  refreshStatusBar()
  fileService.markBaseline()

  /* ---------- Ctrl+F 全局快捷键 ---------- */
  const handleCtrlF = (e: KeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault()
      e.stopPropagation()
      searchBar.toggle()
    }
  }
  document.addEventListener('keydown', handleCtrlF, true)
  layout.sourceTextarea.addEventListener('keydown', handleCtrlF)

  /* ---------- 主进程命令路由（菜单 / 全局快捷键） ---------- */
  window.typewren.onCommand((name, payload) => {
    switch (name) {
      case 'new-file':
        void fileService.newFile().then(() => outline.refresh())
        break
      case 'open-file':
        void fileService.openFile().then(() => outline.refresh())
        break
      case 'save':
        void fileService.save()
        break
      case 'save-as':
        void fileService.saveAs()
        break
      case 'save-and-close':
        void fileService.saveThenClose()
        break

      case 'open-file-path':
        if (payload && typeof payload === 'object' && 'path' in payload && 'content' in payload) {
          void fileService.loadContentFromPath(
            (payload as { path: string; content: string }).path,
            (payload as { path: string; content: string }).content
          ).then(() => outline.refresh())
        }
        break

      /* 格式 */
      case 'format:bold':
        toggleTextMark(instance.editor, 'strong')
        break
      case 'format:italic':
        toggleTextMark(instance.editor, 'emphasis')
        break
      case 'format:strike':
        toggleTextMark(instance.editor, 'strikethrough')
        break
      case 'format:inline-code':
        toggleTextMark(instance.editor, 'inlineCode')
        break
      case 'format:link':
        void insertOrUpdateLink(instance.editor)
        break
      case 'format:image':
        void insertImage(instance.editor)
        break

      /* 标题与列表 */
      case 'heading':
        setHeadingLevel(
          instance.editor,
          typeof payload === 'number' ? payload : 0
        )
        break
      case 'list:bullet':
        wrapInListKind(instance.editor, 'bullet')
        break
      case 'list:number':
        wrapInListKind(instance.editor, 'ordered')
        break
      case 'list:task':
        insertTaskItem(instance.editor)
        break

      /* 块级插入 */
      case 'block:quote':
        toggleBlockquote(instance.editor)
        break
      case 'block:code':
        makeCodeBlock(instance.editor)
        break
      case 'block:math':
        insertMathBlock(instance.editor)
        break
      case 'block:math-inline':
        insertMathInline(instance.editor)
        break
      case 'insert:table':
        insertTable(instance.editor)
        break
      case 'insert:hr':
        insertHr(instance.editor)
        break

      /* 视图 */
      case 'view:source':
        sourceMode.toggle()
        break
      case 'view:outline':
        toggleOutlinePanel()
        break
      case 'view:theme': {
        layout.btnThemeToggle.textContent =
          toggleTheme() === 'dark' ? '☀ 亮色' : '☾ 暗色'
        break
      }

      default:
        break
    }
  })

  /* ---------- 拖拽文件到窗口：新窗口打开 ---------- */
  const MARKDOWN_EXTS = ['.md', '.markdown', '.mdown']

  const handleDragOver = (e: DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDrop = (e: DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const files = Array.from(e.dataTransfer?.files ?? [])
    for (const file of files) {
      const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
      if (MARKDOWN_EXTS.includes(ext)) {
        const filePath = window.typewren.getPathForFile(file)
        window.typewren.openFileInNewWindow(filePath)
      }
    }
  }

  // 使用捕获阶段，确保在 ProseMirror 处理之前拦截
  document.addEventListener('dragover', handleDragOver, true)
  document.addEventListener('drop', handleDrop, true)

  /* ---------- 重新加载前保存当前文档状态 ---------- */
  const RELOAD_STATE_KEY = 'typewren.reload-state'

  window.addEventListener('beforeunload', () => {
    const filePath = fileService.getFilePath()
    const markdown = fileService.getRawMarkdown()
    // 只在有内容时保存
    if (markdown || filePath) {
      sessionStorage.setItem(RELOAD_STATE_KEY, JSON.stringify({
        filePath,
        markdown
      }))
    }
  })

  // 检查是否有重新加载前保存的状态
  const savedState = sessionStorage.getItem(RELOAD_STATE_KEY)
  if (savedState) {
    sessionStorage.removeItem(RELOAD_STATE_KEY)
    try {
      const { filePath, markdown } = JSON.parse(savedState)
      if (markdown) {
        await fileService.loadContentFromPath(filePath, markdown)
        outline.refresh()
      }
    } catch {
      // 解析失败忽略
    }
  }

  instance.focus()
}

void bootstrap()
