import { dialog, type BrowserWindow } from 'electron';

import type { CommandName } from '../shared/ipc';
import { resumeSessionSaves } from './docRegistry';
import { isTestMode } from './runMode';

/* ============================================================
 * 关闭保护（原 io.ts 拆出；io.ts 收敛为 IPC 注册层）：
 * 文档未保存时拦截 close，弹原生三选框（保存 / 不保存 / 取消），
 * 两个后续动作都交回渲染进程完成（保存后 / 放弃后各自回调 request-force-close），
 * 以便渲染层同步清理崩溃恢复草稿。
 * 必须用异步 showMessageBox：同步版会阻塞主进程事件循环，
 * 多窗口下其它窗口的 IPC（脏同步 / 主题广播 / 更新进度）会被一起卡住。
 * ============================================================ */

/** 派发命令函数类型（由 io.ts 注入，避免 closeGuard ↔ io 循环依赖） */
export type SendCommandFn = (win: BrowserWindow, name: CommandName, payload?: unknown) => void;

/** 每个窗口的脏状态（渲染进程通过 win:set-dirty 同步） */
const dirtyMap = new WeakMap<BrowserWindow, boolean>();
/** 已确认强制关闭（跳过保存保护） */
const forceCloseSet = new WeakSet<BrowserWindow>();
/**
 * 关闭流程占用中：三选框显示期间 + 已决策（保存/不保存）等待收尾期间。
 * 这段时间的重复 close 请求必须拦截但**不能放行**——早退不 preventDefault 的旧实现
 * 会让二次点击直接关窗、脏文档无提示丢失；而再弹一次框会出现两个保存流程对写。
 */
const closingFlow = new WeakSet<BrowserWindow>();
/** 占用期间收到过 close 请求：流程结束后（含中止）补一次关闭，让用户的重试生效 */
const closeRetry = new WeakSet<BrowserWindow>();
/**
 * 占用看门狗：保存流程的中止（取消另存为/写盘失败/冲突确认取消）有 noteCloseFlowAborted
 * 回报，但仍可能有未覆盖的中止路径（渲染层异常等）；超时释放防"窗口从此关不掉"。
 */
const CLOSE_FLOW_TIMEOUT_MS = 30_000;
const closeWatchdog = new WeakMap<BrowserWindow, NodeJS.Timeout>();

/** 渲染进程同步脏状态 */
export function markWindowDirty(win: BrowserWindow, dirty: boolean): void {
  dirtyMap.set(win, dirty);
}

/** 已确认强制关闭并关闭窗口（win:request-force-close / 渲染进程崩溃兜底共用） */
export function forceCloseWindow(win: BrowserWindow): void {
  forceCloseSet.add(win);
  dirtyMap.set(win, false);
  if (!win.isDestroyed()) win.close();
}

function clearWatchdog(win: BrowserWindow): void {
  const timer = closeWatchdog.get(win);
  if (timer) {
    clearTimeout(timer);
    closeWatchdog.delete(win);
  }
}

/** 释放关闭流程占用；期间积压过 close 请求则补一次关闭（重新走完整保护流程） */
function releaseCloseFlow(win: BrowserWindow): void {
  clearWatchdog(win);
  closingFlow.delete(win);
  if (closeRetry.delete(win) && !win.isDestroyed()) {
    win.close();
  }
}

/**
 * 保存/放弃流程中止回报（取消另存为、file:write 失败、冲突确认取消）：
 * 释放占用，否则窗口会带着"关闭中"状态直到看门狗超时。
 * 无关闭流程进行中时是无操作（另存为等普通流程也走这些 IPC）。
 */
export function noteCloseFlowAborted(win: BrowserWindow | null): void {
  if (win && closingFlow.has(win)) releaseCloseFlow(win);
}

/**
 * 挂关闭保护 + 渲染进程崩溃兜底。
 * send 由调用方注入（io.ts 的 sendCommand）。
 */
export function attachCloseGuard(win: BrowserWindow, send: SendCommandFn): void {
  // render-process-gone 是 webContents 事件（挂在 win 上注册不上）
  win.webContents.on('render-process-gone', () => {
    // 渲染进程崩溃后关闭保护派发的"保存/不保存"命令石沉大海（无人应答）→ 脏窗永远关不掉。
    // 崩溃时内容已无从挽救，直接按已确认强制关闭处理（能关掉才是唯一出路）
    forceCloseSet.add(win);
    dirtyMap.set(win, false);
    if (!win.isDestroyed()) win.close();
  });

  // 测试模式跳过关闭保护（e2e 主路径不与原生弹框打交道）
  if (isTestMode()) return;

  win.on('close', (event) => {
    if (!dirtyMap.get(win) || forceCloseSet.has(win)) return;

    if (closingFlow.has(win)) {
      // 占用期的重复关闭请求：拦截但不放行（放行 = 无提示丢弃脏文档），
      // 也不再弹框（二次弹框会开出第二个保存流程对写同一文件）
      event.preventDefault();
      closeRetry.add(win);
      // 退出流程可能正等着这个窗口关（before-quit 已落最终快照）：
      // close 被拦即退出被中止，会话防抖存盘必须恢复
      resumeSessionSaves();
      return;
    }

    event.preventDefault();
    closingFlow.add(win);
    // close 被拦 = 可能中止了正在进行的退出（before-quit 已置 quitting 拦掉防抖写），
    // 无论用户接下来选什么，剩余运行期的会话更新都不能丢
    resumeSessionSaves();

    void (async () => {
      try {
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          title: 'Typewren',
          message: '文档尚未保存',
          detail: '你的更改将在关闭后丢失。是否保存更改？',
          buttons: ['保存', '不保存', '取消'],
          defaultId: 0,
          cancelId: 2,
          noLink: true
        });
        if (response === 0) {
          // 让渲染进程先执行保存流程（无路径时会另存为），完成后回调。
          // 占用保持到 request-force-close / 窗口关闭 / 流程中止（见函数头注释），
          // 并挂看门狗兜底"保存流程无回执中止"的未覆盖路径
          closeWatchdog.set(
            win,
            setTimeout(() => releaseCloseFlow(win), CLOSE_FLOW_TIMEOUT_MS)
          );
          send(win, 'save-and-close');
        } else if (response === 1) {
          // 放弃更改：渲染层清理草稿后回调强制关闭（abandonForClose 必定回调，
          // 看门狗只是极端兜底）
          closeWatchdog.set(
            win,
            setTimeout(() => releaseCloseFlow(win), CLOSE_FLOW_TIMEOUT_MS)
          );
          send(win, 'discard-close');
        } else {
          // 取消（含 Esc）：本次关闭流程到此为止，立即释放占用
          releaseCloseFlow(win);
        }
      } catch {
        releaseCloseFlow(win);
      }
    })();
  });
}
