import {
  DEFAULT_SETTINGS,
  FONT_PRESETS,
  SETTINGS_LIMITS,
  type ThemePreference
} from '../../../shared/settings';
import { getAppSettings, subscribeAppSettings, updateAppSettings } from '@/services/appSettings';

/* ============================================================
 * 偏好设置对话框（自研 DOM 模态，仿 promptDialog）
 * - 修改即时生效：控件事件 → updateAppSettings（本地立即应用 + 主进程持久化/广播）
 * - Enter / Esc / 点遮罩 / 「关闭」均可关闭（与 promptDialog 交互一致）
 * - 设置存储广播后重建控件值（多窗口一致）；聚焦中的控件不被打断
 * ============================================================ */

export class SettingsDialog {
  private overlay: HTMLDivElement | null = null;
  private unsubscribe: (() => void) | null = null;

  open(): void {
    if (this.overlay) return;
    const previousFocus = document.activeElement as HTMLElement | null;

    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.id = 'settings-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'settings-dialog';
    dialog.id = 'settings-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '偏好设置');

    const title = document.createElement('div');
    title.className = 'settings-title';
    title.textContent = '偏好设置';
    const hint = document.createElement('div');
    hint.className = 'settings-hint';
    hint.textContent = '修改即时生效，并自动保存。';

    const body = document.createElement('div');
    body.className = 'settings-body';

    body.append(
      this.section('编辑器排版', [
        this.selectRow('字体', 'settings-font-family', this.fontOptions(), (v) =>
          updateAppSettings({ fontFamily: v })
        ),
        this.numberRow(
          '字号（px）',
          'settings-font-size',
          SETTINGS_LIMITS.fontSize.min,
          SETTINGS_LIMITS.fontSize.max,
          1,
          (v) => updateAppSettings({ fontSize: v })
        ),
        this.numberRow(
          '行距',
          'settings-line-height',
          SETTINGS_LIMITS.lineHeight.min,
          SETTINGS_LIMITS.lineHeight.max,
          0.05,
          (v) => updateAppSettings({ lineHeight: v })
        ),
        this.numberRow(
          '编辑区宽度（px）',
          'settings-editor-width',
          SETTINGS_LIMITS.editorWidth.min,
          SETTINGS_LIMITS.editorWidth.max,
          20,
          (v) => updateAppSettings({ editorWidth: v })
        )
      ]),
      this.section('主题', [
        this.selectRow(
          '默认主题',
          'settings-theme',
          [
            { label: '跟随系统', value: 'system' },
            { label: '亮色', value: 'light' },
            { label: '暗色', value: 'dark' }
          ],
          (v) => updateAppSettings({ theme: v as ThemePreference })
        )
      ]),
      this.section('保存', [
        this.checkboxRow('自动保存（按间隔把脏文档写盘）', 'settings-autosave', (v) => {
          updateAppSettings({ autoSave: v });
        }),
        this.numberRow(
          '自动保存间隔（秒）',
          'settings-autosave-interval',
          SETTINGS_LIMITS.autoSaveInterval.min,
          SETTINGS_LIMITS.autoSaveInterval.max,
          5,
          (v) => updateAppSettings({ autoSaveInterval: v })
        ),
        this.numberRow(
          '崩溃恢复草稿间隔（秒）',
          'settings-draft-interval',
          SETTINGS_LIMITS.draftInterval.min,
          SETTINGS_LIMITS.draftInterval.max,
          5,
          (v) => updateAppSettings({ draftInterval: v })
        )
      ]),
      this.section('编辑辅助', [
        this.checkboxRow('拼写检查', 'settings-spellcheck', (v) => {
          updateAppSettings({ spellcheck: v });
        }),
        this.checkboxRow('成对符号补全', 'settings-autopairs', (v) => {
          updateAppSettings({ autoPairs: v });
        })
      ])
    );

    const actions = document.createElement('div');
    actions.className = 'settings-actions';

    const btnReset = document.createElement('button');
    btnReset.id = 'settings-reset';
    btnReset.type = 'button';
    btnReset.className = 'prompt-btn';
    btnReset.textContent = '恢复默认';
    btnReset.title = '恢复本窗口所有设置到默认值';
    btnReset.addEventListener('click', () => {
      updateAppSettings({ ...DEFAULT_SETTINGS });
    });

    const btnCancel = document.createElement('button');
    btnCancel.id = 'settings-close';
    btnCancel.type = 'button';
    btnCancel.className = 'prompt-btn prompt-btn-primary';
    btnCancel.textContent = '关闭';

    actions.append(btnReset, btnCancel);
    dialog.append(title, hint, body, actions);
    overlay.append(dialog);
    document.body.append(overlay);

    const close = (): void => {
      this.close();
      if (previousFocus && previousFocus.isConnected) previousFocus.focus();
    };

    btnCancel.addEventListener('click', close);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    document.addEventListener('keydown', this.onKeydown);
    this.unsubscribe = subscribeAppSettings(() => this.render());

    this.overlay = overlay;
    this.render();
    requestAnimationFrame(() => {
      dialog.querySelector<HTMLSelectElement>('#settings-font-family')?.focus();
    });
  }

  private onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.close();
  };

  close(): void {
    document.removeEventListener('keydown', this.onKeydown);
    if (!this.overlay) return;
    this.overlay.remove();
    this.overlay = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** 按当前设置重建控件值（聚焦中的控件不打断输入） */
  private render(): void {
    const s = getAppSettings();
    this.setValue('#settings-font-family', s.fontFamily);
    this.setValue('#settings-font-size', String(s.fontSize));
    this.setValue('#settings-line-height', String(s.lineHeight));
    this.setValue('#settings-editor-width', String(s.editorWidth));
    this.setValue('#settings-theme', s.theme);
    this.setChecked('#settings-autosave', s.autoSave);
    this.setValue('#settings-autosave-interval', String(s.autoSaveInterval));
    this.setValue('#settings-draft-interval', String(s.draftInterval));
    this.setChecked('#settings-spellcheck', s.spellcheck);
    this.setChecked('#settings-autopairs', s.autoPairs);
    const intervalInput = this.overlay?.querySelector<HTMLInputElement>(
      '#settings-autosave-interval'
    );
    if (intervalInput) intervalInput.disabled = !s.autoSave;
  }

  private setValue(selector: string, value: string): void {
    const el = this.overlay?.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
    if (el && document.activeElement !== el && el.value !== value) el.value = value;
  }

  private setChecked(selector: string, value: boolean): void {
    const el = this.overlay?.querySelector<HTMLInputElement>(selector);
    if (!el || document.activeElement === el) return;
    el.checked = value;
  }

  private fontOptions(): { label: string; value: string }[] {
    const current = getAppSettings().fontFamily;
    if (current && !FONT_PRESETS.some((p) => p.value === current)) {
      return [...FONT_PRESETS, { label: `自定义（${current}）`, value: current }];
    }
    return FONT_PRESETS;
  }

  /* ---------- 控件构造 ---------- */

  private section(title: string, rows: HTMLElement[]): HTMLElement {
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = title;
    fieldset.append(legend, ...rows);
    return fieldset;
  }

  private row(labelText: string, control: HTMLElement): HTMLElement {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const label = document.createElement('label');
    label.className = 'settings-label';
    label.textContent = labelText;
    if (control.id) label.htmlFor = control.id;
    row.append(label, control);
    return row;
  }

  private selectRow(
    labelText: string,
    id: string,
    options: { label: string; value: string }[],
    onChange: (value: string) => void
  ): HTMLElement {
    const select = document.createElement('select');
    select.id = id;
    select.className = 'settings-select';
    for (const opt of options) {
      const el = document.createElement('option');
      el.value = opt.value;
      el.textContent = opt.label;
      select.appendChild(el);
    }
    select.addEventListener('change', () => onChange(select.value));
    return this.row(labelText, select);
  }

  private numberRow(
    labelText: string,
    id: string,
    min: number,
    max: number,
    step: number,
    onChange: (value: number) => void
  ): HTMLElement {
    const input = document.createElement('input');
    input.id = id;
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.className = 'settings-input';
    input.addEventListener('input', () => {
      const value = Number(input.value);
      if (Number.isFinite(value)) onChange(value);
    });
    return this.row(labelText, input);
  }

  private checkboxRow(
    labelText: string,
    id: string,
    onChange: (value: boolean) => void
  ): HTMLElement {
    const checkbox = document.createElement('input');
    checkbox.id = id;
    checkbox.type = 'checkbox';
    checkbox.className = 'settings-checkbox';
    checkbox.addEventListener('change', () => onChange(checkbox.checked));
    return this.row(labelText, checkbox);
  }
}
