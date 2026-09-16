/* ============================================================
 * 应用骨架 DOM 构建（无框架，纯 TS 生成）
 * 结构：
 *   #app
 *    ├ aside#outline-panel   大纲面板
 *    └ main#editor-container 编辑区
 *   footer#status-bar         状态栏
 * ============================================================ */

import { MENU_TOP_LABELS } from '../../../shared/menu';

export interface AppLayout {
  root: HTMLElement;
  titlebar: HTMLElement;
  titlebarIcon: HTMLImageElement;
  titlebarTitle: HTMLElement;
  menubar: HTMLElement;
  app: HTMLElement;
  sidePanel: HTMLElement;
  sideTabs: HTMLElement;
  btnTabFiles: HTMLButtonElement;
  btnTabOutline: HTMLButtonElement;
  sideCollapseBtn: HTMLButtonElement;
  outlineTree: HTMLElement;
  filetreeItems: HTMLElement;
  btnSidebarToggle: HTMLButtonElement;
  editorContainer: HTMLElement;
  editorHost: HTMLElement;
  sourceContainer: HTMLElement;
  sourceTextarea: HTMLElement;
  statusBar: HTMLElement;
  wordCountEl: HTMLElement;
  cursorPosEl: HTMLElement;
  btnSourceToggle: HTMLButtonElement;
  btnThemeToggle: HTMLButtonElement;
  btnBackgroundSettings: HTMLButtonElement;
  searchBarContainer: HTMLElement;
}

export function buildLayout(parent: HTMLElement): AppLayout {
  parent.innerHTML = '';

  /* ---------- 自绘标题栏（替代原生标题栏，规避 DWM 渐变） ---------- */
  const titlebar = document.createElement('div');
  titlebar.id = 'titlebar';
  titlebar.setAttribute('role', 'toolbar');

  const titlebarIcon = document.createElement('img');
  titlebarIcon.id = 'titlebar-icon';
  titlebarIcon.src = './icon.png';
  titlebarIcon.alt = '';
  titlebarIcon.draggable = false;

  const titlebarTitle = document.createElement('span');
  titlebarTitle.id = 'titlebar-title';
  titlebarTitle.textContent = 'Typewren';
  titlebar.append(titlebarIcon, titlebarTitle);

  /* ---------- 自绘菜单栏（点击弹出原生子菜单） ---------- */
  const menubar = document.createElement('div');
  menubar.id = 'menubar';
  menubar.setAttribute('role', 'menubar');
  for (const label of MENU_TOP_LABELS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menubar-item';
    btn.textContent = label;
    btn.dataset.label = label;
    menubar.appendChild(btn);
  }

  const app = document.createElement('div');
  app.id = 'app';

  /* ---------- 侧边栏（文件 / 大纲 可切换卡片，Typora 式） ---------- */
  const sidePanel = document.createElement('aside');
  sidePanel.id = 'side-panel';

  const sideTabs = document.createElement('div');
  sideTabs.className = 'side-tabs';
  const btnTabFiles = document.createElement('button');
  btnTabFiles.type = 'button';
  btnTabFiles.className = 'side-tab';
  btnTabFiles.dataset.tab = 'files';
  btnTabFiles.textContent = '文件';
  const btnTabOutline = document.createElement('button');
  btnTabOutline.type = 'button';
  btnTabOutline.className = 'side-tab';
  btnTabOutline.dataset.tab = 'outline';
  btnTabOutline.textContent = '大纲';
  sideTabs.append(btnTabFiles, btnTabOutline);

  const outlineTree = document.createElement('nav');
  outlineTree.id = 'outline-tree';

  const filetreeItems = document.createElement('nav');
  filetreeItems.id = 'filetree-items';

  // 收起按钮（Typora 右下角 ‹ 形态）
  const sideCollapseBtn = document.createElement('button');
  sideCollapseBtn.type = 'button';
  sideCollapseBtn.className = 'side-collapse';
  sideCollapseBtn.title = '收起侧边栏 (Ctrl+\\)';
  sideCollapseBtn.textContent = '‹';

  sidePanel.append(sideTabs, outlineTree, filetreeItems, sideCollapseBtn);

  /* ---------- 编辑区 ---------- */
  const editorContainer = document.createElement('main');
  editorContainer.id = 'editor-container';

  const editorHost = document.createElement('div');
  editorHost.id = 'editor';
  editorContainer.appendChild(editorHost);

  /* ---------- 源代码视图（与编辑区互斥显示） ---------- */
  const sourceContainer = document.createElement('div');
  sourceContainer.id = 'source-editor';

  const sourceTextarea = document.createElement('div');
  sourceTextarea.id = 'source-textarea';
  sourceTextarea.contentEditable = 'true';
  sourceTextarea.spellcheck = false;
  sourceTextarea.setAttribute('data-placeholder', 'Markdown 源代码');
  sourceTextarea.setAttribute('aria-label', 'Markdown 源代码');
  sourceContainer.appendChild(sourceTextarea);

  /* ---------- 搜索栏容器（由 searchBar 组件挂载，放在 app 内部） ---------- */
  const searchBarContainer = document.createElement('div');
  searchBarContainer.id = 'search-bar-container';

  app.append(sidePanel, editorContainer, sourceContainer, searchBarContainer);

  /* ---------- 状态栏 ---------- */
  const statusBar = document.createElement('footer');
  statusBar.id = 'status-bar';

  const btnSourceToggle = document.createElement('button');
  btnSourceToggle.type = 'button';
  btnSourceToggle.title = '切换源代码 / 渲染视图 (Ctrl+/)';
  btnSourceToggle.textContent = '</> 源码';

  const btnSidebarToggle = document.createElement('button');
  btnSidebarToggle.type = 'button';
  btnSidebarToggle.title = '显示 / 隐藏侧边栏 (Ctrl+\\)';
  btnSidebarToggle.textContent = '☰ 侧栏';

  const wordCountEl = document.createElement('span');
  wordCountEl.id = 'word-count';
  wordCountEl.textContent = '字数 0';

  const spacer = document.createElement('span');
  spacer.className = 'spacer';

  const cursorPosEl = document.createElement('span');
  cursorPosEl.id = 'cursor-pos';
  cursorPosEl.textContent = '行 1，列 1';

  const btnThemeToggle = document.createElement('button');
  btnThemeToggle.type = 'button';
  btnThemeToggle.title = '切换亮色 / 暗色主题';
  btnThemeToggle.textContent = '☾ 暗色';

  const btnBackgroundSettings = document.createElement('button');
  btnBackgroundSettings.type = 'button';
  btnBackgroundSettings.title = '背景图片设置';
  btnBackgroundSettings.textContent = '🖼 背景';

  statusBar.append(
    btnSourceToggle,
    btnSidebarToggle,
    wordCountEl,
    spacer,
    cursorPosEl,
    btnBackgroundSettings,
    btnThemeToggle
  );

  parent.append(titlebar, menubar, app, statusBar);

  return {
    root: parent,
    titlebar,
    titlebarIcon,
    titlebarTitle,
    menubar,
    app,
    sidePanel,
    sideTabs,
    btnTabFiles,
    btnTabOutline,
    sideCollapseBtn,
    outlineTree,
    filetreeItems,
    btnSidebarToggle,
    editorContainer,
    editorHost,
    sourceContainer,
    sourceTextarea,
    statusBar,
    wordCountEl,
    cursorPosEl,
    btnSourceToggle,
    btnThemeToggle,
    btnBackgroundSettings,
    searchBarContainer
  };
}
