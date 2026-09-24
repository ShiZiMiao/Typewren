/* ============================================================
 * contenteditable 文本插入工具
 * 先派发 beforeinput：真实输入链路上默认动作即插入并进入撤销栈；
 * 但**程序化 dispatchEvent 构造的 beforeinput 浏览器不会执行默认插入**，
 * 且其返回值（未被 preventDefault → true）不等于插入成功——
 * 故派发后核对目标内容，没变化就回退 document.execCommand（仍触发 input）。
 * 调用前需保证选区已就绪（可选：焦点不在目标上时先 focus 不改变选区）。
 *
 * 【换行坑（实测，勿回退）】execCommand('insertText') 对含 '\n' 的文本是
 * **分块语义**：Blink 把换行当段落/换行符处理，产出 <div>/<br> 结构——
 * 而源码模式的 getText/脏检测/保存全基于 textContent，块边界换行从
 * textContent 直接消失（Enter 打 `第一行\n第二行` 实测落成
 * `第一行内容<div>第二行内容</div>`，textContent 丢换行）。含换行的文本
 * 必须走 execCommand('insertHTML')：HTML 串解析后 '\n' 原样落成文本节点
 * 字符（实测 html/text 均为 `AB\n`，input 事件照发、撤销栈不受影响）。
 * 文本先经 escapeHtml 转义——`<b>` 等必须逐字插入，不能被解析成元素。
 * ============================================================ */

import { escapeHtml } from './escape';

/** 光标在 target.textContent 中的字符偏移（无选区/越界返回 null） */
function caretTextOffset(target: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const pre = document.createRange();
  pre.selectNodeContents(target);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

/** 把光标放到 textContent 偏移处（高亮拆分出多个文本节点时逐段累计定位） */
function setCaretTextOffset(target: HTMLElement, offset: number): void {
  const selection = window.getSelection();
  if (!selection) return;
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  let acc = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (offset <= acc + node.data.length) {
      const range = document.createRange();
      range.setStart(node, Math.min(offset - acc, node.data.length));
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    acc += node.data.length;
  }
}

/**
 * 尾部换行光标锚维护（<br> 尾锚，同 ProseMirror 的 trailingBreak 模式）。
 *
 * 【Blink 坑（实测 rect/typing 双证，勿回退）】pre-wrap 文本以 '\n' 结尾时，
 * 「'\n' 之后」这个光标位**没有布局落点**：末尾空行无 inline box，OffsetMapping
 * 无从映射——实测 getBoundingClientRect() 返回 (0,0)（光标直接不可见），
 * 且随后打字被规范位拉回 '\n' **之前**插入（`AB` 回车后打 `输入` 得 `AB输入\n`，
 * 新行文字反而被挤到换行符前面）。给空行一个 <br> 锚点后光标位即恢复可渲染/
 * 可打字（实测打字落在 '\n' 之后、光标 rect 落在第二行）。
 *
 * <br> 对 textContent **零贡献**（getText/脏检测/保存/退出写回全基于
 * textContent），换行语义仍完全由 '\n' 文本字符承担——绝不能反过来用 <br>
 * 表示换行（textContent 丢换行是本模块头号坑）。打字/删除后 Blink 会自行
 * 消费或暴露该锚（实测打字落位后 <br> 自动消失），本函数按"末字符是不是 '\n'"
 * 幂等补/删，供插入链路与 input 自愈共用。
 */
export function syncTrailingBreak(target: HTMLElement): void {
  const last = target.lastElementChild;
  const hasAnchor = last !== null && last.tagName === 'BR';
  if ((target.textContent ?? '').endsWith('\n')) {
    if (!hasAnchor) target.appendChild(document.createElement('br'));
  } else if (hasAnchor) {
    last.remove();
  }
}

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
  if (text.includes('\n')) {
    const caretBefore = caretTextOffset(target);
    document.execCommand('insertHTML', false, escapeHtml(text));
    // insertHTML 后光标会停在插入内容**之前**（实测随后输入跑到 '\n' 前面，
    // textContent 成 `AB输入\n`）——按 textContent 偏移显式挪到插入内容之后，
    // 与普通打字语义一致。插入落在**文末**时还需补 <br> 尾锚，否则那个
    // "之后"光标位没有布局落点、打字照样跳回 '\n' 前（详见 syncTrailingBreak）；
    // execCommand 的空白清理可能顺手吃掉既有尾锚，故每次插入后都幂等重同步。
    syncTrailingBreak(target);
    if (caretBefore !== null) setCaretTextOffset(target, caretBefore + text.length);
  } else {
    document.execCommand('insertText', false, text);
  }
}
