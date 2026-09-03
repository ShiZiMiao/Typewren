/* ============================================================
 * contenteditable 文本插入工具
 * 优先走 Input Events 的 beforeinput（默认动作即插入并进入撤销栈），
 * 环境不支持时回退 document.execCommand（已废弃，仅兜底）。
 * 调用前需保证选区已就绪（可选：焦点不在目标上时先 focus 不改变选区）。
 * ============================================================ */

export function insertTextViaInputEvent(target: HTMLElement, text: string): void {
  try {
    const event = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: text,
      bubbles: true,
      cancelable: true
    });
    // 未被 preventDefault 时，浏览器会执行默认插入动作
    if (target.dispatchEvent(event)) return;
  } catch {
    // InputEvent 构造不可用（老内核）时走兜底
  }
  document.execCommand('insertText', false, text);
}
