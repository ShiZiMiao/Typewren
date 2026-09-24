/* ============================================================
 * Typewren 渲染进程入口
 * 装配顺序：样式 → 布局骨架 → 编辑器 → UI 组件 → 命令路由
 * bootstrap 只做装配编排，各段状态机/快捷键/拖拽/恢复流程收口到
 * 文件内的局部装配函数（initXxx / restoreSessionState），行为与历史
 * 单体 bootstrap 一致。
 * ============================================================ */

import '@milkdown/kit/prose/view/style/prosemirror.css';
import '@milkdown/kit/prose/tables/style/tables.css';
import '@milkdown/kit/prose/gapcursor/style/gapcursor.css';
import 'katex/dist/katex.min.css';

import './styles/variables.css';
import './styles/layout.css';
import './styles/editor.css';
import './styles/widgets.css';
import './styles/search.css';
import './styles/background.css';

import { createEditor, bindWritingModes } from '@/editor/createEditor';
import { toggleTextMark } from '@/editor/actions';
import { buildLayout } from '@/ui/layout';
import type { AppLayout } from '@/ui/layout';
import { activeHeadingIndex, createOutlinePanel } from '@/ui/outlinePanel';
import { SourceModeController } from '@/ui/sourceMode';
import { updateStatusBar } from '@/ui/statusBar';
import { initThemeToggle, setThemePreferenceSink } from '@/ui/theme';
import { createWritingModes } from '@/ui/writingModes';
import { createSpellcheck } from '@/ui/spellcheck';
import { createAutoPairs } from '@/editor/autoPairs';
import { createSearchBar } from '@/ui/searchBar';
import type { SearchBar } from '@/ui/searchBar';
import { BackgroundSettingsController } from '@/ui/backgroundSettings';
import { createFileTreePanel } from '@/ui/fileTree';
import type { FileTreePanel } from '@/ui/fileTree';
import { installZoomShortcut } from '@/ui/zoom';
import { UpdateDownloadToast } from '@/ui/updateToast';
import { FileService } from '@/services/fileService';
import {
  getAppSettings,
  loadAppSettings,
  registerCapabilityAppliers,
  updateAppSettings
} from '@/services/appSettings';
import { SettingsDialog } from '@/ui/settingsDialog';
import {
  ImageService,
  dirnamePath,
  handleImageDrop,
  handleImagePaste
} from '@/services/imagePasteService';
import { refreshAllImageSrcs, setImageDocDirProvider } from '@/editor/imageView';
import { registerCommandRouter } from '@/commandRouter';
import { localStore, sessionStore } from '@/util/storage';
import { isMarkdownPath } from '../../shared/ipc';

/** 大纲刷新防抖等待 */
const OUTLINE_DEBOUNCE_MS = 120;
/** 自绘菜单栏点击后去掉高亮的延时 */
const MENUBAR_HIGHLIGHT_MS = 800;
/** 侧栏收起态 / 激活卡片的镜像键（localStorage） */
const OUTLINE_KEY = 'typewren.outline-collapsed';
const TAB_KEY = 'typewren.side-tab';
/** 欢迎页只在首启显示一次 */
const WELCOME_SEEN_KEY = 'typewren.welcome-seen';
/** 重新加载（Ctrl+R）前的文档快照键（sessionStorage：只活到本标签页） */
const RELOAD_STATE_KEY = 'typewren.reload-state';

const WELCOME_MARKDOWN =
  `# 欢迎使用 Typewren

单栏**所见即所得**：输入 Markdown 语法立即渲染，光标移开后只留下排版结果。

## 快速上手

- 输入 \`# \`` +
  ` 空格` +
  ` 把当前行变为标题
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
`;

function debounce<T extends (...args: never[]) => void>(
  fn: T,
  waitMs: number
): (...args: Parameters<T>) => void {
  let timer: number | undefined;
  return (...args: Parameters<T>) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), waitMs);
  };
}

/* ============================================================
 * 局部装配函数（纯拆分，行为不变）
 * ============================================================ */

/**
 * Ctrl+组合键的逻辑键判定：e.code 与 e.key 双判（与 shared/zoomKeys 同风格）。
 * 只判 e.key 在非拉丁布局下失效（西里尔/希腊布局 Ctrl+F 的 key 是本地化字符）；
 * 只判 e.code 会把物理键位当快捷键（Dvorak 等布局用户按的是逻辑键）——
 * 二者取或。shift/alt 排除保持旧语义（旧实现 key 恒为小写，
 * Ctrl+Shift+F 的 key='F' 本就不命中）。
 */
function isModHotkey(e: KeyboardEvent, code: string, key: string): boolean {
  return (
    (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === code || e.key === key)
  );
}

/** 裸 Alt 拦截：Windows 上 Alt 会聚焦窗口菜单栏（哪怕 autoHideMenuBar），
 * 配合主进程 setMenuBarVisibility(false) 双保险，防左上角误弹原生菜单。
 * 注意：Alt 组合键（Alt+F4 等系统级）在 keydown 阶段 intercept 不到，
 * 这里只管"裸 Alt 触发菜单栏聚焦"的路径。 */
function installAltGuard(): void {
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Alt' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
      }
    },
    true
  );
}

/** 自绘菜单栏：点击顶级项弹出原生子菜单。
 * 各模式开关状态由控制器持有（bootstrap 后段才创建），经 getModeStates 晚绑定：
 * 展开菜单时取最新勾选态（menu:popup 每次重建模板，天然新鲜） */
function initMenubar(layout: AppLayout, getModeStates: () => Record<string, boolean>): void {
  layout.menubar.querySelectorAll<HTMLButtonElement>('.menubar-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rect = btn.getBoundingClientRect();
      // 传视口 CSS 坐标；× zoomFactor → 窗口 DIP 的换算在主进程 normalizePopupPosition
      window.typewren.popupMenu(btn.dataset.label ?? '', rect.left, rect.bottom, getModeStates());
      btn.classList.add('open');
      window.setTimeout(() => btn.classList.remove('open'), MENUBAR_HIGHLIGHT_MS);
    });
  });
}

/** 侧边栏（文件 / 大纲 卡片切换 + 收起）状态机；状态持久化供下次启动 */
function initSidebar(
  layout: AppLayout,
  onFilesTab: () => void
): { toggleSidebar: () => void } {
  let outlineCollapsed = localStore.get(OUTLINE_KEY) === '1';
  /** 当前激活的侧栏卡片（files | outline） */
  let activeTab = localStore.get(TAB_KEY) === 'files' ? 'files' : 'outline';

  const applySidebarState = (): void => {
    layout.app.classList.toggle('outline-collapsed', outlineCollapsed);
    // 收起态与展开态文案相同（收起入口在状态栏/快捷键，此处仅作状态指示）
    layout.btnSidebarToggle.textContent = '☰ 侧栏';
    layout.btnSidebarToggle.classList.toggle('active', !outlineCollapsed);
    localStore.set(OUTLINE_KEY, outlineCollapsed ? '1' : '0');

    // tab 高亮与内容显示（互斥切换：激活卡片显示，另一张整个隐藏）
    layout.btnTabFiles.classList.toggle('active', activeTab === 'files');
    layout.btnTabOutline.classList.toggle('active', activeTab === 'outline');
    layout.outlineTree.style.display = activeTab === 'outline' ? '' : 'none';
    layout.filetreeItems.style.display = activeTab === 'files' ? '' : 'none';
    localStore.set(TAB_KEY, activeTab);
  };
  applySidebarState();

  const toggleSidebar = (): void => {
    outlineCollapsed = !outlineCollapsed;
    applySidebarState();
  };

  const switchTab = (tab: 'files' | 'outline'): void => {
    activeTab = tab;
    applySidebarState();
    // 首次切到文件卡片时刷新文件树（懒加载，避免每次启动都列目录）
    if (tab === 'files') onFilesTab();
  };

  layout.btnSidebarToggle.addEventListener('click', toggleSidebar);
  layout.btnTabFiles.addEventListener('click', () => switchTab('files'));
  layout.btnTabOutline.addEventListener('click', () => switchTab('outline'));

  return { toggleSidebar };
}

/** Ctrl+F / Ctrl+H / Ctrl+` 全局快捷键 + 缩放快捷键兜底。
 * getSearchBar 晚绑定（搜索栏在编辑器装配后才创建）。 */
function initShortcuts(getSearchBar: () => SearchBar | null, toggleInlineCode: () => void): void {
  const handleCtrlFH = (e: KeyboardEvent): void => {
    if (isModHotkey(e, 'KeyF', 'f')) {
      e.preventDefault();
      e.stopPropagation();
      getSearchBar()?.toggle();
    } else if (isModHotkey(e, 'KeyH', 'h')) {
      e.preventDefault();
      e.stopPropagation();
      // 幂等"确保搜索栏打开 + 替换行可见"（与 edit:replace 命令同路径）
      getSearchBar()?.openWithReplace();
    }
  };
  document.addEventListener('keydown', handleCtrlFH, true);

  /* Ctrl+` 行内代码全局快捷键：
   * Electron 不认 'CmdOrCtrl+`' 加速器（globalShortcut.register 返回 false，
   * 菜单里显示的快捷键实际不生效），按键会落到页面——在这里处理，
   * 与菜单命令走同一个 toggleTextMark 路径。 */
  const handleCtrlBackquote = (e: KeyboardEvent): void => {
    if (isModHotkey(e, 'Backquote', '`')) {
      e.preventDefault();
      e.stopPropagation();
      toggleInlineCode();
    }
  };
  document.addEventListener('keydown', handleCtrlBackquote, true);

  /* 缩放快捷键（Ctrl+= / Ctrl++ / Ctrl+-）全局兜底：
   * role 加速器默认串失灵、'CmdOrCtrl++' 写法解析抛错（见 AGENTS.md 决策 #20），
   * 按键落页面后在 ui/zoom.ts 统一处理；Ctrl+0 保留给段落→正文。 */
  installZoomShortcut();
}

/** 拖拽文件到窗口：新窗口打开 / 空文档就地打开 / 图片本地化插入 */
function initDragDrop(fileService: FileService, imageService: ImageService): void {
  const handleDragOver = (e: DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer?.files ?? []);

    // 原有逻辑：拖入 .md → 当前窗口空文档就地打开，否则新窗口打开
    const mdFiles = files.filter((file) => isMarkdownPath(file.name));
    if (mdFiles.length > 0) {
      // 空文档槽位**只消费一次**（消费即置假）：旧实现循环内即时求值 isEmpty，
      // 首份的异步 loadContentFromPath 未落地前第二份仍判"空文档"也走就地打开，
      // 两次 loadContent 并发交错互踩文档状态
      let emptySlot = !fileService.getFilePath() && !fileService.isDirty;
      for (const file of mdFiles) {
        const filePath = window.typewren.getPathForFile(file);
        if (emptySlot) {
          emptySlot = false;
          void window.typewren.readFileContent(filePath).then((result) => {
            if (result) {
              void fileService.loadContentFromPath(result.path, result.content);
            }
          });
        } else {
          window.typewren.openFileInNewWindow(filePath);
        }
      }
      return;
    }

    // 图片文件 / 网络图片 URL → 本地化后插入编辑器
    handleImageDrop(imageService, e);
  };

  // 使用捕获阶段，确保在 ProseMirror 处理之前拦截
  document.addEventListener('dragover', handleDragOver, true);
  document.addEventListener('drop', handleDrop, true);
}

/** 重新加载（Ctrl+R）前保存当前文档状态（reload 后一拍内恢复） */
function installReloadSnapshot(fileService: FileService): void {
  window.addEventListener('beforeunload', () => {
    const filePath = fileService.getFilePath();
    const markdown = fileService.getRawMarkdown();
    // 只在有内容时保存
    if (markdown || filePath) {
      sessionStore.set(RELOAD_STATE_KEY, JSON.stringify({ filePath, markdown }));
    }
  });
}

/**
 * 启动恢复流程：reload 快照 → 主进程登记的"待打开"文件（文件关联/二次启动）。
 * takePendingOpen 必须等命令路由与各服务就绪后再拉取——比主进程
 * did-finish-load 推送可靠（命令路由在 bootstrap 末尾才订阅）。
 */
async function restoreSessionState(
  fileService: FileService,
  refreshOutline: () => void
): Promise<void> {
  // ---------- 检查是否有重新加载前保存的状态 ----------
  const savedState = sessionStore.get(RELOAD_STATE_KEY);
  if (savedState) {
    sessionStore.remove(RELOAD_STATE_KEY);
    try {
      const parsed = JSON.parse(savedState) as {
        filePath?: unknown;
        markdown?: unknown;
      };
      const { filePath, markdown } = parsed;
      if (typeof markdown === 'string' && markdown) {
        // 约定 filePath: string | null（null = 未命名文档）。loadContentFromPath
        // 形参类型是 string（历史签名），运行时内部 loadContent 本就收
        // string | null——这里把"无路径"显式归一 **null** 传入：旧实现归一 ''
        // 与约定不符（isEmptyDocument 判 `filePath === null` 恒假、
        // win:set-path 上报空串被主进程 validDocPath 拒收）。
        const restorePath =
          typeof filePath === 'string' && filePath !== '' ? filePath : null;
        await fileService.loadContentFromPath(restorePath as unknown as string, markdown);
        refreshOutline();
      }
    } catch {
      // 解析失败忽略
    }
  }

  // ---------- 拉取主进程登记的"待打开"文件 ----------
  const pending = await window.typewren.takePendingOpen();
  if (pending) {
    if (pending.restore) {
      // 崩溃恢复草稿：以磁盘为基线加载草稿内容，呈未保存状态
      await fileService.restoreDraft(pending.path, pending.content);
    } else {
      await fileService.loadContentFromPath(pending.path, pending.content);
    }
    refreshOutline();
  }
}

/** 首启显示欢迎页，之后空白（一次性标记持久化） */
function resolveInitialMarkdown(): string {
  const isFirstLaunch = localStore.get(WELCOME_SEEN_KEY) === null;
  if (isFirstLaunch) localStore.set(WELCOME_SEEN_KEY, '1');
  return isFirstLaunch ? WELCOME_MARKDOWN : '';
}

async function bootstrap(): Promise<void> {
  // 设置须在手建布局之前读取：排版 CSS 变量与主题在首帧渲染前就位
  await loadAppSettings();

  const layout = buildLayout(document.getElementById('app-root')!);
  installAltGuard();

  /* ---------- 主题 ---------- */
  // 主题变更 → 写回设置存储（settings.json 权威；localStorage 镜像同步）
  setThemePreferenceSink((preference) => updateAppSettings({ theme: preference }));
  initThemeToggle(layout.btnThemeToggle, getAppSettings().theme);

  /* ---------- 自绘菜单栏 / 侧边栏 ---------- */
  // 控制器晚于编辑器创建，getModeStates 先放空实现、装配完再换真身
  let getModeStates: () => Record<string, boolean> = () => ({});
  initMenubar(layout, () => getModeStates());
  let fileTreeRef: FileTreePanel | null = null;
  const sidebar = initSidebar(layout, () => fileTreeRef?.refresh());

  /* ---------- 创建编辑器 ---------- */
  // 各服务在 createEditor 之后实例化（编辑器回调只在初始化完成后触发，
  // 闭包引用后续声明的 const 绑定是安全的；若回调在初始化期间触发会暴露 TDZ，
  // 属预期的时序缺陷而非静默错误）
  // 图片视图的"文档目录"来自 fileService，而 fileService 晚于 createEditor 创建：
  // 先挂一个逃生者（null 安全），实例化后再 refreshAllImageSrcs 补偿一次
  let fileServiceRef: FileService | null = null;
  setImageDocDirProvider(() => {
    const p = fileServiceRef?.getFilePath();
    return p ? dirnamePath(p) : null;
  });
  // 搜索栏同样晚创建：文档变化回调经 ref 晚绑定重扫高亮
  let searchBarRef: SearchBar | null = null;
  const refreshStatusBar = (): void => {
    updateStatusBar(instance.editor, layout, sourceMode.getSourceState());
  };

  const refreshOutline = debounce(() => {
    outline.refresh();

    // 光标所在标题联动高亮
    const total = layout.outlineTree.querySelectorAll('.outline-item').length;
    if (total > 0) {
      outline.setActive(activeHeadingIndex(instance.editor, total));
    } else {
      outline.setActive(null);
    }
  }, OUTLINE_DEBOUNCE_MS);

  const instance = await createEditor({
    root: layout.editorHost,
    initialMarkdown: resolveInitialMarkdown(),
    onMarkdownUpdated: () => fileService.handleDocUpdated(),
    onViewChanged: (change) => {
      refreshStatusBar();
      refreshOutline();
      // 搜索高亮存的 DOM Range 随文档变化陈旧（替换会抛 RangeError/错位），
      // 文档变化即重扫（保持序号、不抢滚动，详见 searchBar.refresh）
      if (change.kind === 'doc') searchBarRef?.refresh();
    },
    // 图片落盘服务恒在（构造于 createEditor 后一拍，回调只在用户粘贴时触发）
    onPaste: (event) => handleImagePaste(imageService, event)
  });

  /* ---------- 初始化各模块 ---------- */
  const fileService = new FileService(window.typewren, instance.editor);
  fileServiceRef = fileService;
  // 打开/会话恢复的文档可能已含图片，初始渲染时 provider 尚未接线，这里补偿一次
  refreshAllImageSrcs();
  fileService.onTitleChange = (title) => {
    layout.titlebarTitle.textContent = title;
  };
  const writingModes = createWritingModes(instance.editor);
  bindWritingModes(writingModes);
  // 开关类设置的初始值由控制器按"localStorage 镜像优先"读取（测试预置兼容），
  // 这里注入写回通道：开关变更统一经设置存储 → 主进程持久化 + 广播
  const spellcheck = createSpellcheck(instance.editor, getAppSettings().spellcheck);
  spellcheck.onToggle = (next) => updateAppSettings({ spellcheck: next });
  const autoPairs = createAutoPairs(instance.editor, getAppSettings().autoPairs);
  autoPairs.onToggle = (next) => updateAppSettings({ autoPairs: next });
  // 模式开关状态只在自绘菜单栏弹出时展示（原生 checkbox ✓），状态栏不重复显示
  getModeStates = () => ({
    'view:focus-mode': writingModes.isFocus,
    'view:typewriter-mode': writingModes.isTypewriter,
    'edit:spellcheck': spellcheck.isEnabled,
    'edit:auto-pairs': autoPairs.isEnabled
  });
  // 设置存储 → 运行时生效点（spellcheck/autoPairs 初始已由构造器处理，
  // 这里只重装定时器：自动保存 / 崩溃恢复草稿间隔）
  registerCapabilityAppliers({
    spellcheck: (enabled) => spellcheck.setEnabled(enabled),
    autoPairs: (enabled) => autoPairs.setEnabled(enabled),
    autoSave: (enabled, intervalSec) => fileService.setAutoSave(enabled, intervalSec),
    draftInterval: (sec) => fileService.setDraftInterval(sec)
  });
  const sourceMode = new SourceModeController(
    instance.editor,
    fileService,
    layout.app,
    layout.sourceTextarea,
    layout.btnSourceToggle,
    refreshStatusBar
  );
  const outline = createOutlinePanel(instance.editor, layout.outlineTree, {
    isSourceMode: () => sourceMode.isActive,
    sourceEl: () => layout.sourceTextarea
  });
  // 源码模式：光标移动 → 大纲 active 高亮联动
  sourceMode.onCaretMove = (text, pos) => outline.updateActiveFromSource(text, pos);
  const imageService = new ImageService(window.typewren, instance.editor, fileService);

  /* ---------- 搜索栏 ---------- */
  const searchBar = createSearchBar(
    layout.searchBarContainer,
    () => sourceMode.isActive,
    () => layout.sourceTextarea,
    instance.editor
  );
  searchBarRef = searchBar;
  // 源码模式的编辑不过 PM（doc 变化通知收不到）：源码区 input 同样要重扫
  layout.sourceTextarea.addEventListener('input', () => searchBarRef?.refresh());

  /* ---------- 背景图片设置（入口在「视图」菜单） ---------- */
  const backgroundSettings = new BackgroundSettingsController();

  /* ---------- 偏好设置对话框（入口在「文件」菜单 Ctrl+,） ---------- */
  const settingsDialog = new SettingsDialog();

  /* ---------- 文件树面板（内容由侧边栏文件卡片承载） ---------- */
  const fileTree = createFileTreePanel({
    root: layout.sidePanel,
    getDocPath: () => fileService.getFilePath(),
    onOpen: (path) => {
      window.typewren.openFileInNewWindow(path);
    }
  });
  fileTreeRef = fileTree;
  // 文档路径变化 → 刷新文件树（加载/另存为后目录可能不同）
  // 同时重解析图片引用（另存为后 ./assets/ 的新基准是文档新目录）
  fileService.onPathChanged = () => {
    fileTree.refresh();
    refreshAllImageSrcs();
  };
  fileTree.refresh();

  /* ---------- 更新下载提示卡（进度由主进程推送，需常驻不销毁） ---------- */
  new UpdateDownloadToast();

  outline.refresh();
  refreshStatusBar();
  fileService.markBaseline();

  /* ---------- 全局快捷键（Ctrl+F/H/` + 缩放） ---------- */
  initShortcuts(
    () => searchBarRef,
    () => toggleTextMark(instance.editor, 'inlineCode')
  );

  /* ---------- 主进程命令路由（菜单 / 全局快捷键） ---------- */
  registerCommandRouter({
    editor: instance.editor,
    fileService,
    imageService,
    sourceMode,
    outline,
    searchBar,
    layout,
    toggleSidebar: sidebar.toggleSidebar,
    writingModes,
    spellcheck,
    autoPairs,
    backgroundSettings,
    settingsDialog
  });

  initDragDrop(fileService, imageService);
  installReloadSnapshot(fileService);
  await restoreSessionState(fileService, () => outline.refresh());

  instance.focus();
}

void bootstrap().catch((error) => {
  console.error('Typewren 渲染进程初始化失败：', error);
  const root = document.getElementById('app-root');
  if (root) {
    root.textContent = `初始化失败：${String(error)}`;
  }
});
