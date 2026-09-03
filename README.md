# Typewren

> 单栏所见即所得 Markdown 桌面编辑器。
> 输入语法即时渲染，仅光标所在节点临时显示原始标记——**没有分栏预览**。

Typewren 基于 Electron + Milkdown（ProseMirror），用原生 TypeScript 渲染层（无前端框架）实现
极简、沉浸的写作体验。

---

## 特性

- **单栏即时渲染**：输入即所见，不再左右分屏。
- **语法高亮**：代码块基于 highlight.js（通过 lowlight → prosemirror-highlight）；
  源码模式用 @lezer/markdown（CodeMirror 6 解析内核）分词，CSS Custom Highlight API 着色。
- **数学公式**：行内 / 块级 LaTeX 公式，KaTeX 渲染（自研节点插件）。
- **表格工具条**：自研浮动工具条，支持插入 / 增删行列 / 对齐。
- **任务列表**：`[ ]` / `[x]` 复选框，点击左侧热区即可翻转。
- **源码模式**：一键在渲染视图与 Markdown 源码之间切换。
- **大纲面板**：基于文档标题层级，点击跳转。
- **亮 / 暗主题**：跟随系统并支持手动切换，标题栏与内容同帧切换无闪烁。
- **自绘标题栏与菜单栏**：规避 Windows 原生标题栏在主题切换时的 ~70ms 渐变延迟。

---

## 技术栈

| 层         | 选型                                                                      | 版本   |
| ---------- | ------------------------------------------------------------------------- | ------ |
| 桌面框架   | Electron                                                                  | ^44    |
| 构建       | electron-vite（main / preload / renderer 三段式）                         | ^5     |
| 编辑器内核 | @milkdown/kit（ProseMirror）                                              | 7.22.x |
| 代码高亮   | highlight.js → lowlight → prosemirror-highlight；源码模式 @lezer/markdown | —      |
| 数学公式   | remark-math + KaTeX（自研节点）                                           | —      |
| 渲染层     | 原生 TypeScript（**无框架**）                                             | —      |
| 打包       | electron-builder → Windows NSIS                                           | ^26    |
| 代码规范   | ESLint（typescript-eslint）+ Prettier                                     | —      |

---

## 下载与安装

前往 [Releases](https://github.com/ShiZiMiao/Typewren/releases) 下载最新安装包
`Typewren Setup x.x.x.exe`，按提示安装即可。

> 开发环境注意：Electron 二进制需通过镜像下载（见下方「开发」），且本机 npm 需
> 对 esbuild / electron 的 postinstall 脚本执行 `npm approve-scripts`。

---

## 开发

### 环境要求

- Node.js ≥ 20
- npm

### 常用命令

```powershell
# 安装依赖（首次需批准 esbuild / electron 的 install 脚本）
npm install

# 开发模式（带 HMR）
npm run dev

# 类型检查 + 生产构建
npm run build

# 完整构建并产出 NSIS 安装包（输出 release/）
npm run dist

# 代码规范：ESLint 检查 + Prettier 格式化
npm run lint
npm run format

# E2E 测试（Playwright）
npm test
```

> 若 Electron 下载缓慢，可设置镜像：
>
> ```powershell
> $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
> $env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
> ```

---

## 快捷键

| 操作                 | 快捷键                   |
| -------------------- | ------------------------ |
| 新建                 | Ctrl/⌘ + N               |
| 打开                 | Ctrl/⌘ + O               |
| 保存                 | Ctrl/⌘ + S               |
| 另存为               | Ctrl/⌘ + Shift + S       |
| 切换源码 / 渲染      | Ctrl/⌘ + /               |
| 大纲面板             | Ctrl/⌘ + \               |
| 切换亮 / 暗主题      | Ctrl/⌘ + Shift + L       |
| 加粗 / 斜体 / 删除线 | Ctrl/⌘ + B / I / Shift+X |
| 标题 1–6 / 正文      | Ctrl/⌘ + 1–6 / 0         |
| 代码块               | Ctrl/⌘ + Alt + C         |
| 数学公式块           | Ctrl/⌘ + Shift + M       |

菜单栏的「文件 / 编辑 / 格式 / 段落 / 视图 / 帮助」可点击展开原生子菜单。

---

## License

MIT
