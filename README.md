# Typewren

> 单栏所见即所得 Markdown 桌面编辑器。
> 输入语法即时渲染，仅光标所在节点临时显示原始标记——**没有分栏预览**。

Typewren 基于 Electron + Milkdown（ProseMirror），用原生 TypeScript 渲染层（无前端框架）实现
极简、沉浸的写作体验。

---

## 特性

### 编辑体验

- **单栏即时渲染**：输入即所见，不再左右分屏；标题 / 列表 / 引用 / 表格 / 代码块即时成型。
- **语法高亮**：代码块基于 highlight.js（lowlight → prosemirror-highlight）；
  源码模式用 @lezer/markdown 分词，CSS Custom Highlight API 着色。
- **代码块语言角标**：右下角显示语言；空语言自动识别（强特征 + highlight.js 评分），
  点击角标就地输入 / 下拉选择语言，识别结果确认后才写入文档。
- **成对符号补全**：正文与代码块内自动成对括号 / 引号（IDE 式，可关闭）。
- **数学公式**：行内 / 块级 LaTeX 公式，KaTeX 渲染（自研节点插件）。
- **Mermaid 图表**：` ```mermaid ` 代码块自动渲染为图表（懒加载，体积不进首屏）。
- **表格**：浮动工具条插入 / 增删行列 / 对齐；表格按内容宽度展开，横向滚动不换行。
- **任务列表**：`[ ]` / `[x]` 复选框，点击左侧热区即可翻转。
- **脚注 / 目录**：原生 Markdown 脚注；`[TOC]` 段落自动生成大纲目录（点击跳转）。

### 视图与模式

- **源码模式**：一键在渲染视图与 Markdown 源码之间切换，双向定位光标位置。
- **大纲面板**：基于文档标题层级，点击跳转（渲染 / 源码模式均可）。
- **文件树**：侧栏「文件」卡片浏览文档目录，面包屑 / 返回上级 / 刷新。
- **焦点模式 & 打字机模式**：当前块高亮其余淡化；光标保持编辑区中部。
- **亮 / 暗主题**：跟随系统并支持手动切换，标题栏与内容同帧切换无闪烁。
- **自绘标题栏与菜单栏**：规避 Windows 原生标题栏在主题切换时的 ~70ms 渐变延迟。

### 内容与导出

- **图片本地化**：粘贴 / 拖拽、Ctrl+Shift+I 插入的图片自动落盘到文档 `assets/`，
  编辑器内按文档目录解析显示（打包任何位置打开不裂图）。
- **导出**：PDF / 自包含 HTML / Word（docx）/ 长图（PNG），排版与编辑器一致。
- **搜索替换**：Ctrl+F / Ctrl+H 搜索与替换（渲染 / 源码模式通用）。

### 数据安全

- **外部修改冲突检测**：保存时磁盘内容与基线比对，三项选择（覆盖 / 重载磁盘 / 取消）。
- **崩溃恢复草稿**：脏文档定时快照，异常退出后启动时恢复（未保存态）。
- **另存为附件迁移**：换目录保存时询问是否一并复制 `assets/`。
- **会话恢复 & 最近文件**：重启恢复上次打开的窗口集合；最近文件菜单 + 系统跳转列表。
- **多窗口**：多个文档同时打开，每个窗口独立文档；重复打开询问跳转或新窗口。
- **文件关联**：双击 `.md` / `.markdown` / `.mdown` 打开；拖拽文件到窗口打开。

### 个性与便利

- **偏好设置**：文件 → 偏好设置…（Ctrl+,）——字体 / 字号 / 行距 / 编辑区宽度 /
  默认主题 / 自动保存间隔 / 崩溃草稿间隔 / 拼写检查 / 成对符号补全，实时生效并持久化。
- **拼写检查**：菜单一键开关（settings 里亦可配置）。
- **更新检查**：自动检查新版本，可下载安装包并显示进度（打包版生效）。

---

## 快捷操作

| 操作                        | 快捷键                       |
| --------------------------- | ---------------------------- |
| 新建 / 打开 / 保存 / 另存为 | Ctrl/⌘ + N / O / S / Shift+S |
| 新建窗口                    | Ctrl/⌘ + Shift + N           |
| 查找 / 替换                 | Ctrl/⌘ + F / H               |
| 切换源码 / 渲染             | Ctrl/⌘ + /                   |
| 大纲面板                    | Ctrl/⌘ + \\                  |
| 加粗 / 斜体 / 删除线        | Ctrl/⌘ + B / I / Shift+X     |
| 行内代码                    | Ctrl/⌘ + `                   |
| 插入链接 / 图片             | Ctrl/⌘ + K / Shift+I         |
| 标题 1–6 / 正文             | Ctrl/⌘ + 1–6 / 0             |
| 代码块 / 数学公式块         | Ctrl/⌘ + Alt + C / Shift+M   |
| 偏好设置                    | Ctrl/⌘ + ,                   |

菜单栏的「文件 / 编辑 / 格式 / 段落 / 视图 / 帮助」可点击展开原生子菜单。

---

## 技术栈

| 层         | 选型                                                                      | 版本   |
| ---------- | ------------------------------------------------------------------------- | ------ |
| 桌面框架   | Electron                                                                  | ^44    |
| 构建       | electron-vite（main / preload / renderer 三段式）                         | ^5     |
| 编辑器内核 | @milkdown/kit（ProseMirror）                                              | 7.22.x |
| 代码高亮   | highlight.js → lowlight → prosemirror-highlight；源码模式 @lezer/markdown | —      |
| 数学公式   | remark-math + KaTeX（自研节点）                                           | —      |
| 图表       | mermaid（懒加载）                                                         | ^12    |
| 渲染层     | 原生 TypeScript（**无框架**）                                             | —      |
| 打包       | electron-builder → Windows NSIS                                           | ^26    |
| 代码规范   | ESLint（typescript-eslint）+ Prettier                                     | —      |

---

## 下载与安装

前往 [Releases](https://github.com/ShiZiMiao/Typewren/releases) 下载最新版本的
`Typewren Setup <版本>.exe` 安装包，按提示安装即可（未签名安装包可能触发 SmartScreen 提示）。

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

## License

MIT
