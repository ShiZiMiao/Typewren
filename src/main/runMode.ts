/* ============================================================
 * 运行模式判定（收口原散落 7 处的 process.argv.includes(...) 双口径）
 * 两个谓词的口径**有意不同**，勿互相替换：
 * - isTestMode（--test）：e2e 主路径。跳过关闭保护 / 草稿 / 会话 / 最近文件等
 *   会写用户数据的副作用，导出直写临时目录，菜单弹出不真弹（防测试跑出的
 *   "莫名其妙弹窗"打到用户屏幕）。
 * - suppressesUi（--test 或 --headless）：只抑制窗口显示（绝不抢用户前台焦点）。
 *   --headless 跑的是**真实实例**（关闭保护/草稿/会话照常工作，
 *   closeGuard/drafts/session 用例依赖它验证真实行为），只是不 show()。
 * argv 参数化仅为单测可注入；生产调用点一律用默认值（进程启动后 argv 不变）。
 * ============================================================ */

/** e2e 测试实例（--test）：跳过一切用户数据副作用与交互弹框 */
export function isTestMode(argv: readonly string[] = process.argv): boolean {
  return argv.includes('--test');
}

/** 窗口显示抑制（--test / --headless）：测试/后台运行不抢前台焦点 */
export function suppressesUi(argv: readonly string[] = process.argv): boolean {
  return argv.includes('--test') || argv.includes('--headless');
}
