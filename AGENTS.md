# Typewren — 项目说明（供后续开发会话快速接续）

单栏所见即所得（Typora 式）Markdown 桌面编辑器。
**禁止分栏预览**：输入语法即时渲染，仅光标所在节点临时显示原始标记。

> 历史：项目曾名 MarkLite（与已有软件重名），2026-08-26 全局更名为 Typewren。
> 目录曾为 `D:\projects\MarkLite`，已镜像迁移至 `D:\projects\Typewren`；
> 旧目录因 opencode 宿主进程占用无法删除，确认无用后可手动删除。

## 技术栈

| 层 | 选型 | 版本 |
|---|---|---|
| 桌面框架 | Electron | ^44 |
| 构建三段式 | electron-vite (main/preload/renderer) | ^5 |
| 编辑器内核 | @milkdown/kit (ProseMirror) | 7.22.x |
| 代码高亮 | highlight.js → lowlight → prosemirror-highlight → @milkdown/plugin-highlight | — |
| 数学公式 | remark-math + KaTeX（自研节点插件） | — |
| 渲染层 | Vanilla TS（**无框架**，勿引入 Vue/React） | — |
| 打包 | electron-builder → Windows NSIS | ^26 |

## 常用命令

```powershell
npm run dev        # 开发模式
npm run build      # typecheck + electron-vite build
npm run dist       # 完整构建 + NSIS 安装包（输出 release/）
```

环境注意：
- Electron 二进制下载需镜像：`$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'`
- 本机 npm 开启 allow-scripts 策略：esbuild / electron 的 postinstall 需 `npm approve-scripts <pkg>` 后 rebuild/install
- Windows 控制台显示中文乱码是 GBK 终端问题，文件本身 UTF-8 无损

## 目录结构

```
src/
├─ main/            主进程：index(入口/单实例) window menu(中文菜单+快捷键) io(IPC)
├─ preload/         contextBridge 暴露 window.typewren
└─ renderer/
   ├─ index.html    CSP 注意：connect-src 含 ws://localhost:* 供 dev HMR
   └─ src/
      ├─ editor/    createEditor(装配) math highlight tableTools taskToggle actions
      ├─ ui/        layout outlinePanel statusBar theme sourceMode
      ├─ services/  fileService（脏检测/保存流/关闭保护协作）
      └─ styles/    variables(双主题CSS变量) layout editor widgets
```

## 关键实现决策（踩坑记录，勿回退）

1. **代码高亮**走 `@milkdown/plugin-highlight` + `prosemirror-highlight/lowlight`，
   底层即 highlight.js；不要用 kit 内置 CodeMirror 版 code-block 组件（非 Typora 风）。
2. **表格工具条是自研的**（editor/tableTools.ts）：官方 `@milkdown/components/table-block`
   内部 import 运行时 Vue，与 Vanilla TS 决策冲突而弃用。命令来自 `@milkdown/kit/prose/tables`。
3. **数学公式无官方预设**（v7 无 preset-latex 包）：math.ts 用 `$remark('MATH_REMARK',()=>remarkMath)`
   + `$nodeSchema` + `$view` 自研节点。序列化端用 `state.addNode(type, undefined, value)`，
   解析端用 `state.addNode(type, {value})` —— 两端 API 不同，勿混用（openNode/addText 是解析端专属）。
4. **任务列表**：gfm 渲染 `li[data-item-type=task][data-checked]`，无原生 checkbox。
   样式用 ::before 画框，taskToggle.ts 在左侧 30px 热区拦截点击翻转 checked。
5. **源码模式**（ui/sourceMode.ts）：进入时把 `fileService.sourceAccessor` 指向 textarea，
   使脏检测/保存读取源码实时内容；退出时先置 null 再 `setMarkdown` 写回。
   FileService.onContentReplaced 负责打开/新建后反向同步 textarea。
6. **主题**：交互切换时以主进程 nativeTheme 为时钟——渲染层发 `theme:set-native` 后
   不立即改 DOM，等主进程 'updated' 广播（`theme:native-updated`）到达再落 `[data-theme]`，
   使内容同刻变色；300ms 超时兜底防 IPC 丢失；启动阶段仍直接落 DOM 防首帧闪错色。
   主进程收到广播同时：重建菜单栏（win32）+ **即时重设 `titleBarOverlay` 配色**。
   CSS 用 `[data-theme]` + `color-scheme` + 滚动条变量。
   **标题栏已自绘（见 #9），不再依赖原生标题栏，故标题栏与内容天然同帧切换。**
7. **标题栏自绘（titleBarOverlay）**：原生标题栏(DWM)在 `nativeTheme` 变化时有约 70ms
   颜色渐变，Electron 无法关闭，导致标题栏切换明显慢于内容。
   方案：`window.ts` 在 win32 用 `titleBarStyle:'hidden'` + `titleBarOverlay`
   （底色/字形色取自 `src/shared/titlebar.ts` 的 `TITLEBAR_PALETTE`，需与
   variables.css 的 `--bg-soft`/`--text-muted` 保持同步）；原生菜单栏随之 `autoHideMenuBar:true`
   （Alt 仍可唤出，快捷键不受影响）。渲染层 `ui/layout.ts` 自绘 `#titlebar`（drag 区域 + 文档标题，
   由 `FileService.onTitleChange` 同步），其背景用 `[data-theme]` 变量，随内容瞬切。
   主进程 `io.ts` 在 nativeTheme 'updated' 时 `setTitleBarOverlay({color,symbolColor})`
   即时重绘按钮区（程序化设置无 DWM 渐变）。配色常量集中在 `src/shared/titlebar.ts`。
   **验证法**：PowerShell + BitBlt 截屏采样标题栏/内容/按钮区像素，三者应在同一 ~8ms 帧内翻转
   （PrintWindow 会强制渲染掩盖渐变，必须用 BitBlt 取真实屏幕像素）。
8. **关闭保护**在主进程 io.ts attachCloseGuard：脏文档 close 时弹原生三选框，
   「保存」→ 发 `save-and-close` 命令 → 渲染层保存成功后调 request-force-close。
9. **启动基线**：main.ts 初始化末尾必须调用 `fileService.markBaseline()`，
   否则欢迎文档一打开就是脏状态。

## IPC 通道

- invoke: `dialog:open-file` / `dialog:save-as` / `file:write` / `dialog:discard-changes`
- send: `win:set-title` / `win:set-dirty` / `win:request-force-close` / `theme:set-native`
- 菜单命令统一走 `cmd` 通道 (name, payload)，渲染层 main.ts switch 路由；
  新增菜单项 = menu.ts item() + main.ts case + （可选）actions.ts 封装。

## Milkdown 装配速查（createEditor.ts）

`.use(commonmark).use(gfm).use(highlight).use(history).use(listener).use(trailing)
.use(cursor)` + math 八件套（remarkMathPlugin/mathBlockSchema/mathInlineSchema/
两个 $view/三个 $inputRule）+ tableTools + taskListToggle + viewEvents + emptyDocPlaceholder。
注意：`$remark/$nodeSchema/$inputRule/$prose` 返回值多为元组型宏，单独 .use() 可以，
放进数组字面量会触发 TS 元组不可赋值错误（mathPreset 因此被拆散注册）。

## 已知事项 / 下一步候选

- 图标已就位：`build/icon.ico` 自动嵌入 exe/安装包；`build/icon.png` 供跨平台目标及
  dev 模式窗口图标（window.ts 中 !app.isPackaged 分支）
- 任务列表「插入任务列表」目前是插入 `- [ ] ` 片段，未做已有列表互转
- 大纲面板点击跳转在源码模式下作用于隐藏视图（无效但无害）
- 未做：最近文件、多标签页、导出（HTML/PDF）、拖拽打开文件
