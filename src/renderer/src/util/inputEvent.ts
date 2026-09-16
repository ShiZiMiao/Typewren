/* ============================================================
 * contenteditable 文本插入工具
 * 先派发 beforeinput：真实输入链路上默认动作即插入并进入撤销栈；
 * 但**程序化 dispatchEvent 构造的 beforeinput 浏览器不会执行默认插入**，
 * 且其返回值（未被 preventDefault → true）不等于插入成功——
 * 故派发后核对目标内容，没变化就回退 document.execCommand（仍触发 input）。
 * 调用前需保证选区已就绪（可选：焦点不在目标上时先 focus 不改变选区）。
 * ============================================================ */

export function insertTextViaInputEvent(target: HTMLElement, text: string): void {
  const before = target.textContent ?? '';
  try {
    const event = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: text,
      bubbles: true,
      cancelable: true
    });
    target.dispatchEvent(event);
  } catch {
    // InputEvent 构造不可用（老内核）时直接走兜底
  }
  // 内容已变化（真实插入路径生效）则成功；否则回退 execCommand
  if ((target.textContent ?? '') !== before) return;
  document.execCommand('insertText', false, text);
}
