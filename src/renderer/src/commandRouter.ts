import type { Editor } from '@milkdown/kit/core';

import { isFileContentPayload } from '../../shared/ipc';
import type { AppLayout } from '@/ui/layout';
import type { OutlineController } from '@/ui/outlinePanel';
import type { SearchBar } from '@/ui/searchBar';
import type { SourceModeController } from '@/ui/sourceMode';
import type { FileService } from '@/services/fileService';
import type { ImageService } from '@/services/imagePasteService';
import { exportDocument } from '@/editor/exportDocument';
import {
  insertHr,
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
} from '@/editor/actions';
import { toggleTheme, syncThemeButton } from '@/ui/theme';
import { applyZoomAction } from '@/ui/zoom';
import { promptDialog } from '@/ui/promptDialog';
import type { WritingModes } from '@/ui/writingModes';
import type { SpellcheckController } from '@/ui/spellcheck';
import type { AutoPairsController } from '@/editor/autoPairs';
import type { BackgroundSettingsController } from '@/ui/backgroundSettings';
import type { SettingsDialog } from '@/ui/settingsDialog';

/* ============================================================
 * 命令路由：主进程菜单 / 快捷键命令 (cmd 通道) → 编辑器与 UI 操作
 * 每个 case 只做转译与装配，具体操作收口到 editor/actions 与 services。
 * ============================================================ */

/** Promise 失败兜底：编辑器已销毁/IPC 抛错等不再裸奔 unhandled——
 * 旧实现 `void fileService.save()` 无 .catch，出错既无提示也无日志线索。
 * 提示面复用 promptDialog（与 actions 的「链接地址无效」同款）。 */
function reportFailure(label: string, error: unknown): void {
  console.error(`${label}失败：`, error);
  void promptDialog({
    title: `${label}失败`,
    label: String(error),
    confirmText: '知道了'
  });
}

/** void Promise 统一挂失败提示（成功路径不打扰） */
function guard(label: string, run: Promise<unknown>): void {
  void run.catch((error: unknown) => reportFailure(label, error));
}

export interface CommandRouterDeps {
  editor: Editor;
  fileService: FileService;
  imageService: ImageService;
  sourceMode: SourceModeController;
  outline: OutlineController;
  searchBar: SearchBar;
  layout: AppLayout;
  toggleSidebar: () => void;
  writingModes: WritingModes;
  spellcheck: SpellcheckController;
  autoPairs: AutoPairsController;
  backgroundSettings: BackgroundSettingsController;
  settingsDialog: SettingsDialog;
}

export function registerCommandRouter(deps: CommandRouterDeps): void {
  const { editor, fileService, imageService, sourceMode, outline, searchBar, layout } = deps;

  window.typewren.onCommand((name, payload) => {
    switch (name) {
      /* 文件 */
      case 'new-file':
        guard('新建文档', fileService.newFile().then(() => outline.refresh()));
        break;
      case 'open-file':
        guard('打开文档', fileService.openFile().then(() => outline.refresh()));
        break;
      case 'save':
        guard('保存', fileService.save());
        break;
      case 'save-as':
        guard('另存为', fileService.saveAs());
        break;
      case 'save-and-close':
        guard('保存', fileService.saveThenClose());
        break;
      case 'discard-close':
        // 关闭保护中选择"不保存"：清理草稿后强制关闭
        fileService.abandonForClose();
        break;
      case 'global:show-in-folder': {
        const filePath = fileService.getFilePath();
        if (filePath) window.typewren.showInFolder(filePath);
        break;
      }
      case 'file:open-smart':
        if (typeof payload === 'string') {
          guard('打开文档', fileService.openSmart(payload));
        }
        break;
      case 'file:preferences':
        deps.settingsDialog.open();
        break;
      case 'export:pdf':
        guard('导出 PDF', exportDocument(editor, fileService, 'pdf'));
        break;
      case 'export:html':
        guard('导出 HTML', exportDocument(editor, fileService, 'html'));
        break;
      case 'export:docx':
        guard('导出 Word', exportDocument(editor, fileService, 'docx'));
        break;
      case 'export:png':
        guard('导出 PNG', exportDocument(editor, fileService, 'png'));
        break;
      case 'open-file-path':
        if (isFileContentPayload(payload)) {
          guard(
            '打开文档',
            fileService.loadContentFromPath(payload.path, payload.content).then(() => outline.refresh())
          );
        }
        break;

      /* 格式 */
      case 'format:bold':
        toggleTextMark(editor, 'strong');
        break;
      case 'format:italic':
        toggleTextMark(editor, 'emphasis');
        break;
      case 'format:strike':
        // 注意：Milkdown gfm 删除线 mark 的 schema id 是 strike_through
        toggleTextMark(editor, 'strike_through');
        break;
      case 'format:inline-code':
        toggleTextMark(editor, 'inlineCode');
        break;
      case 'format:link':
        guard('插入链接', insertOrUpdateLink(editor));
        break;
      case 'format:image':
        // 原生图片选择框 → 落盘到文档 assets 后插入（与粘贴同一条落盘链路）
        guard('插入图片', imageService.pickAndInsertLocally());
        break;

      /* 标题与列表 */
      case 'heading':
        setHeadingLevel(editor, typeof payload === 'number' ? payload : 0);
        break;
      case 'list:bullet':
        wrapInListKind(editor, 'bullet');
        break;
      case 'list:number':
        wrapInListKind(editor, 'ordered');
        break;
      case 'list:task':
        insertTaskItem(editor);
        break;

      /* 块级插入 */
      case 'block:quote':
        toggleBlockquote(editor);
        break;
      case 'block:code':
        makeCodeBlock(editor);
        break;
      case 'block:math':
        insertMathBlock(editor);
        break;
      case 'block:math-inline':
        insertMathInline(editor);
        break;
      case 'insert:table':
        insertTable(editor);
        break;
      case 'insert:hr':
        insertHr(editor);
        break;

      /* 编辑 */
      case 'edit:find':
        searchBar.toggle();
        break;
      case 'edit:replace':
        // 幂等语义"确保搜索栏打开 + 替换行可见"：旧实现 toggle()+toggleReplace()
        // 组合在替换面板已开时会把整个搜索栏关掉、再把 replace 行显示在隐藏容器里
        searchBar.openWithReplace();
        break;

      /* 视图 */
      case 'view:source':
        sourceMode.toggle();
        break;
      case 'view:outline':
        // 侧边栏（文件/大纲卡片）整体收起/弹出
        deps.toggleSidebar();
        break;
      case 'view:theme': {
        // 与按钮点击同路径：toggleTheme 后经 syncThemeButton 同步文案**与 title**
        // （旧实现只改 textContent，与 theme.ts 的按钮同步各写一份且 title 不更新）
        syncThemeButton(layout.btnThemeToggle, toggleTheme());
        break;
      }
      case 'view:background-settings':
        deps.backgroundSettings.togglePanel();
        break;
      case 'view:focus-mode':
        deps.writingModes.toggleFocus();
        break;
      case 'view:typewriter-mode':
        deps.writingModes.toggleTypewriter();
        break;
      case 'view:zoom-in':
        applyZoomAction('in');
        break;
      case 'view:zoom-out':
        applyZoomAction('out');
        break;
      case 'view:zoom-reset':
        applyZoomAction('reset');
        break;
      case 'edit:spellcheck':
        deps.spellcheck.toggle();
        break;
      case 'edit:auto-pairs':
        deps.autoPairs.toggle();
        break;

      default:
        break;
    }
  });
}
