# 发版遗留事项（未做 / 存疑）

> 来源：2026-09-22 发版前全面审查 + 66 项修复批次（见 AGENTS.md 决策 #21）。
> 修复批次已全量完成并通过 272 例 e2e；以下为当时**有意跳过或留观**的事项，
> 按建议优先级排列。处理完请从本文件删除对应条目。

## 建议排入后续小版本

1. **docx 硬换行只是 `'\n'` 占位**
   位置：`src/renderer/src/editor/docxExport.ts`（extractRuns）+ `src/main/export.ts`（runOf）
   背景：结构化 JSON 只能以 `'\n'` 独立 run 表达硬换行，前后文本已不粘连，但不是真 `<w:br/>`。
   建议：main/export.ts 的 `runOf` 支持换行 run → 输出 `<w:br/>`。

2. **editor 层反向依赖 services/ui（耦合债）**
   位置：`src/renderer/src/editor/exportDocument.ts:6-12`（依赖 FileService 类型）、
   `editor/mermaid.ts:7`（依赖 ui 的 currentTheme）
   背景：修复批次中为避免跨模块冲突跳过的纯重构（低危）。
   建议：exportDocument 改收纯数据参数（markdown/title/theme），由 commandRouter 装配；
   mermaid 的主题经参数传入。

3. **隐藏窗口 `mouse.move` 每事件约 5s 的机制未查明**
   位置：e2e 运行时（tests/background.spec.ts 等拖动用例受影响）
   背景：修复批次实测每次 mouse.move 派发固定 ~5009ms（wheel 约 2s），原因未定位；
   已放宽用例超时到 60s（约 2× 余量），慢机器仍可能贴边。
   建议：查 Playwright 无头派发链路（疑似隐藏窗口的固定节流/计时器）；必要时改合成
   事件派发（注意「真实输入管线」验证口径的取舍）。

4. **playwright.config 无构建钩子**
   位置：`playwright.config.ts`
   背景：e2e 直接跑 `out/` 产物，**改源码后必须先 `npm run build`**，否则被陈旧构建误导
   （修复批次中实际踩过一轮）。AGENTS.md 决策 #21 已有文字提醒。
   建议：加 globalSetup 自动构建（或校验 out/ 比 src/ 新，过期即报错退出）。

5. **SSRF 判定在 `--test` 下放行**
   位置：`src/main/images.ts`（isBlockedFetchHost / image:download）
   背景：imageDownload.spec 的 mock 图片服务就是 127.0.0.1，本地无公网回环替身，
   故 --test 放行环回；真实模式已收紧（环回/私有字面 IP 拒绝），判定纯函数有 23 例单测，
   但 e2e 只覆盖放行路径。
   建议：给 e2e 造非环回替身（hosts 映射或代理层 mock）后补齐拒绝路径 e2e。

6. **图片文件名含 `%25` 字面形态的解码歧义**
   位置：`src/renderer/src/editor/imageView.ts`（decodeImageRef）与
   `services/imagePasteService.ts`（encodeMarkdownPath）成对编解码
   背景：文件名本身含 `%25`（如 `50%25.png`）时解码后歧义成 `50%.png`，编码方案固有边角。
   建议：落盘文件名做白名单化（重命名消歧），或编码方案换 URI-safe 基名。

## 留观（语义已定，如需变更需重新设计）

7. **会话恢复出的文档不进「最近文件」**
   位置：`src/main/io.ts`（最近文件推迟到 take-pending-open 且仅 recent 标记）、docRegistry
   背景：修复批次的既定语义——避免每次启动都把上次退出时的文档重排进 MRU
   （"最近使用"变成"启动顺序"）。首轮真实打开仍会记录。
   建议：如产品要恢复旧行为，需设计"会话恢复不算使用"的独立标记，勿简单回退。

8. **源码写回文本与 savedMarkdown 字符串不等但 doc 等价时判"干净"**
   位置：`src/renderer/src/services/fileService.ts`（handleDocUpdated 重建快照分支）
   背景：如 `a\~~b` 与 `a~~b` 序列化后文本不同但渲染 doc 等价，退出源码后不置脏。
   语义可辩护（内容一致），已在代码注释注明。
   建议：保持现状；若用户反馈"退出源码提示未保存"再改为字符串严格相等。

9. **关闭保护看门狗（30s）是兜底而非根治**
   位置：`src/main/closeGuard.ts`（watchdog + closeRetry）
   背景：保存中止的三条主路径（另存为取消/写盘失败/确认取消）已有 noteCloseFlowAborted
   精确回报；未覆盖的中止路径靠 30s 看门狗补关收场。
   建议：随 closeGuard 后续演进补全中止回报路径，最后移除看门狗。

10. **会话/设置写盘的 flush 与在途写交错窗口**
    位置：`src/main/session.ts`、`docRegistry.ts`、`drafts.ts`、`settings.ts`
    背景：已做 `prev.then(write)` 串行链 + stamp 防旧覆新，理论窗口已闭合，
    但未经故障注入验证（before-quit 与定时器同刻竞态的极端情形）。
    建议：补一条故障注入测试（mock 慢写盘 + 退出）验证"最新一次必胜"。

11. **docx 图片/公式为占位文本**
    位置：`src/renderer/src/editor/docxExport.ts`
    背景：结构化 JSON 不承载二进制，`![alt](src)` / `$…$` 以占位文本输出，维持原设计。
    建议：如需富 docx，扩展导出协议（图片转内嵌二进制引用），属功能增强而非缺陷。
