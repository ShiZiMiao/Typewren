import type { Editor } from '@milkdown/kit/core'

import { isFileContentPayload } from '../../shared/ipc'
import type { AppLayout } from '@/ui/layout'
import type { OutlineController } from '@/ui/outlinePanel'
import type { SearchBar } from '@/ui/searchBar'
import type { SourceModeController } from '@/ui/sourceMode'
import type { FileService } from '@/services/fileService'
import { exportDocument } from '@/editor/exportDocument'
import {
  insertHr,
  insertImage,
  insertMathBlock,
  insertMathInline,
  insertOrUpdateLink,
  insertTable,
  insertTaskItem,
  makeCodeBlock,
  setHeadingLevel,
  toggleBlockquote,
  toggleTextMark,
  wrapInListKind
} from '@/editor/actions'
import { toggleTheme } from '@/ui/theme'

/* ============================================================
 * 命令路由：主进程菜单 / 快捷键命令 (cmd 通道) → 编辑器与 UI 操作
 * 每个 case 只做转译与装配，具体操作收口到 editor/actions 与 services。
 * ============================================================ */

export interface CommandRouterDeps {
  editor: Editor
  fileService: FileService
  sourceMode: SourceModeController
  outline: OutlineController
  searchBar: SearchBar
  layout: AppLayout
  toggleOutlinePanel: () => void
}

export function registerCommandRouter(deps: CommandRouterDeps): void {
  const { editor, fileService, sourceMode, outline, searchBar, layout } = deps

  window.typewren.onCommand((name, payload) => {
    switch (name) {
      /* 文件 */
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
      case 'export:pdf':
        void exportDocument(editor, fileService, 'pdf')
        break
      case 'export:html':
        void exportDocument(editor, fileService, 'html')
        break
      case 'open-file-path':
        if (isFileContentPayload(payload)) {
          void fileService
            .loadContentFromPath(payload.path, payload.content)
            .then(() => outline.refresh())
        }
        break

      /* 格式 */
      case 'format:bold':
        toggleTextMark(editor, 'strong')
        break
      case 'format:italic':
        toggleTextMark(editor, 'emphasis')
        break
      case 'format:strike':
        // 注意：Milkdown gfm 删除线 mark 的 schema id 是 strike_through
        toggleTextMark(editor, 'strike_through')
        break
      case 'format:inline-code':
        toggleTextMark(editor, 'inlineCode')
        break
      case 'format:link':
        void insertOrUpdateLink(editor)
        break
      case 'format:image':
        void insertImage(editor)
        break

      /* 标题与列表 */
      case 'heading':
        setHeadingLevel(editor, typeof payload === 'number' ? payload : 0)
        break
      case 'list:bullet':
        wrapInListKind(editor, 'bullet')
        break
      case 'list:number':
        wrapInListKind(editor, 'ordered')
        break
      case 'list:task':
        insertTaskItem(editor)
        break

      /* 块级插入 */
      case 'block:quote':
        toggleBlockquote(editor)
        break
      case 'block:code':
        makeCodeBlock(editor)
        break
      case 'block:math':
        insertMathBlock(editor)
        break
      case 'block:math-inline':
        insertMathInline(editor)
        break
      case 'insert:table':
        insertTable(editor)
        break
      case 'insert:hr':
        insertHr(editor)
        break

      /* 编辑 */
      case 'edit:find':
        searchBar.toggle()
        break
      case 'edit:replace':
        searchBar.toggle()
        searchBar.toggleReplace()
        break

      /* 视图 */
      case 'view:source':
        sourceMode.toggle()
        break
      case 'view:outline':
        deps.toggleOutlinePanel()
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
}