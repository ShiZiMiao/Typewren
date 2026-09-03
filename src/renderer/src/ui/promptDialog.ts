/* ============================================================
 * 轻量模态输入框 —— window.prompt 的替代实现
 * Electron 渲染进程不支持 window.prompt（调用直接抛错），
 * 菜单里的「插入链接 / 插入图片」因此改用自研对话框：
 * 单输入 + 确定/取消，Enter 确认、Esc 取消、点遮罩取消。
 * 返回 Promise<string | null>（null = 取消/关闭）。
 * ============================================================ */

export interface PromptDialogOptions {
  /** 标题（同时作为对话框 aria-label） */
  title: string;
  /** 输入框上方说明文字 */
  label?: string;
  /** 初始值（打开时全选，便于覆盖输入） */
  defaultValue?: string;
  /** 占位提示 */
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
}

export function promptDialog(options: PromptDialogOptions): Promise<string | null> {
  const previousFocus = document.activeElement as HTMLElement | null;

  const overlay = document.createElement('div');
  overlay.className = 'prompt-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'prompt-dialog';
  dialog.id = 'prompt-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', options.title);

  const title = document.createElement('div');
  title.className = 'prompt-title';
  title.textContent = options.title;

  const input = document.createElement('input');
  input.id = 'prompt-input';
  input.type = 'text';
  input.spellcheck = false;
  if (options.label) {
    const label = document.createElement('label');
    label.className = 'prompt-label';
    label.textContent = options.label;
    label.htmlFor = input.id;
    dialog.append(title, label, input);
  } else {
    dialog.append(title, input);
  }
  if (options.placeholder) input.placeholder = options.placeholder;

  const actions = document.createElement('div');
  actions.className = 'prompt-actions';

  const btnCancel = document.createElement('button');
  btnCancel.id = 'prompt-cancel';
  btnCancel.type = 'button';
  btnCancel.className = 'prompt-btn';
  btnCancel.textContent = options.cancelText ?? '取消';

  const btnOk = document.createElement('button');
  btnOk.id = 'prompt-ok';
  btnOk.type = 'button';
  btnOk.className = 'prompt-btn prompt-btn-primary';
  btnOk.textContent = options.confirmText ?? '确定';

  actions.append(btnCancel, btnOk);
  dialog.append(actions);
  overlay.append(dialog);
  document.body.append(overlay);

  let settled = false;
  const close = (value: string | null): void => {
    if (settled) return;
    settled = true;
    overlay.remove();
    // 焦点还给打开前的元素（已在文档中时）
    if (previousFocus && previousFocus.isConnected) {
      previousFocus.focus();
    }
    resolve(value);
  };

  let resolve!: (value: string | null) => void;
  const promise = new Promise<string | null>((r) => {
    resolve = r;
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      close(input.value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(null);
    }
  });
  btnOk.addEventListener('click', () => close(input.value));
  btnCancel.addEventListener('click', () => close(null));
  // 点击遮罩（非对话框区域）视为取消
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close(null);
  });

  input.value = options.defaultValue ?? '';
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });

  return promise;
}
