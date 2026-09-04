/* ============================================================
 * 背景图片设置面板：支持自定义背景图片、透明度、模糊度
 * 设置保存到 localStorage，应用到编辑区域
 * ============================================================ */

const STORAGE_KEY = 'typewren.background';

export interface BackgroundSettings {
  imageUrl: string;
  opacity: number;
  blur: number;
  size: 'cover' | 'contain' | 'auto';
  /** CSS background-position 百分比串（如 '50% 100%'），由拖动预览框写回 */
  position: string;
  /** 滚轮缩放倍数（≥1，作用于 cover/contain/auto 基准尺寸之上） */
  zoom: number;
}

const DEFAULT_SETTINGS: BackgroundSettings = {
  imageUrl: '',
  opacity: 0.5,
  blur: 2.5,
  size: 'cover',
  position: '50% 100%',
  zoom: 1
};

/** 旧版本关键字位置 → 百分比（固定值/九宫格时代无拖动预览）。
 *  center/bottom 系当时无控件写死的默认值，并非用户选择，统一落到当前默认（下）。 */
const LEGACY_POSITIONS: Record<string, string> = {
  'left top': '0% 0%',
  'center top': '50% 0%',
  'right top': '100% 0%',
  'left center': '0% 50%',
  center: '50% 100%',
  'right center': '100% 50%',
  'left bottom': '0% 100%',
  'center bottom': '50% 100%',
  'right bottom': '100% 100%',
  bottom: '50% 100%'
};

const isPercentPosition = (value: string): boolean => /^-?\d+(\.\d+)?% -?\d+(\.\d+)?%$/.test(value);

export class BackgroundSettingsController {
  private settings: BackgroundSettings;
  private panel: HTMLElement | null = null;
  private overlay: HTMLElement | null = null;
  private dragBox: HTMLElement | null = null;
  private dragImg: HTMLImageElement | null = null;
  private dragHint: HTMLElement | null = null;
  private zoomValueEl: HTMLSpanElement | null = null;
  private imgNatural: { w: number; h: number } | null = null;
  private dragOffsets: { left: number; top: number } | null = null;

  constructor() {
    this.settings = this.loadSettings();
    this.applySettings();
    // 编辑器区域尺寸变化（窗口缩放/大纲折叠）时重算 px 背景尺寸
    const observer = new ResizeObserver(() => this.applySettings());
    const container = document.getElementById('editor-container');
    const source = document.getElementById('source-editor');
    if (container) observer.observe(container);
    if (source) observer.observe(source);
  }

  private loadSettings(): BackgroundSettings {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as BackgroundSettings;
        const storedPosition = parsed.position ?? '';
        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          // 旧版本 position 是关键字（'center'/'bottom'/九宫格值），迁到百分比；
          // 已是百分比串（拖动预览框写入）的原样保留
          position: isPercentPosition(storedPosition)
            ? storedPosition
            : (LEGACY_POSITIONS[storedPosition] ?? DEFAULT_SETTINGS.position),
          // 旧默认值（透明度 0.3 / 模糊 0）视为从未调过，跟进新默认；用户改过的值原样保留
          opacity:
            parsed.opacity === 0.3
              ? DEFAULT_SETTINGS.opacity
              : (parsed.opacity ?? DEFAULT_SETTINGS.opacity),
          blur: parsed.blur === 0 ? DEFAULT_SETTINGS.blur : (parsed.blur ?? DEFAULT_SETTINGS.blur),
          zoom:
            typeof parsed.zoom === 'number' && Number.isFinite(parsed.zoom) && parsed.zoom >= 1
              ? parsed.zoom
              : DEFAULT_SETTINGS.zoom
        };
      }
    } catch {
      // 解析失败使用默认值
    }
    return { ...DEFAULT_SETTINGS };
  }

  private saveSettings(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
  }

  private applySettings(): void {
    const root = document.documentElement;
    const app = document.getElementById('app');

    if (this.settings.imageUrl) {
      root.style.setProperty('--bg-image-url', `url('${this.settings.imageUrl}')`);
      root.style.setProperty('--bg-image-opacity', String(this.settings.opacity));
      root.style.setProperty('--bg-image-blur', `${this.settings.blur}px`);
      root.style.setProperty('--bg-image-size', this.effectiveBackgroundSize());
      root.style.setProperty('--bg-image-position', this.settings.position);
      app?.classList.add('has-background');
    } else {
      app?.classList.remove('has-background');
      root.style.removeProperty('--bg-image-url');
      root.style.removeProperty('--bg-image-opacity');
      root.style.removeProperty('--bg-image-blur');
      root.style.removeProperty('--bg-image-size');
      root.style.removeProperty('--bg-image-position');
    }
  }

  /** 编辑器背景尺寸：cover/contain/auto 基准 × 滚轮缩放，算成 px（编辑区实时测量，缩放随窗口自适应） */
  private effectiveBackgroundSize(): string {
    if (!this.imgNatural) return this.settings.size; // 图片未加载完成，先用 CSS 关键字兜底
    const area = this.measureBgArea();
    if (area.w <= 0 || area.h <= 0) return this.settings.size;
    const { w, h } = this.imgNatural;
    let scale =
      this.settings.size === 'cover'
        ? Math.max(area.w / w, area.h / h)
        : this.settings.size === 'contain'
          ? Math.min(area.w / w, area.h / h)
          : 1;
    scale *= this.settings.zoom;
    return `${Math.round(w * scale * 100) / 100}px ${Math.round(h * scale * 100) / 100}px`;
  }

  private measureBgArea(): { w: number; h: number } {
    const container = document.getElementById('editor-container');
    const source = document.getElementById('source-editor');
    const el = container && container.offsetWidth > 0 ? container : source;
    if (!el) return { w: 0, h: 0 };
    return { w: el.clientWidth, h: el.clientHeight };
  }

  togglePanel(): void {
    if (this.panel?.classList.contains('visible')) {
      this.hidePanel();
    } else {
      this.showPanel();
    }
  }

  private showPanel(): void {
    if (!this.panel) {
      this.createPanel();
    }
    this.updateUI();
    this.panel?.classList.add('visible');
    this.overlay?.classList.add('visible');
  }

  hidePanel(): void {
    this.panel?.classList.remove('visible');
    this.overlay?.classList.remove('visible');
  }

  private createPanel(): void {
    // 创建遮罩层
    this.overlay = document.createElement('div');
    this.overlay.className = 'bg-settings-overlay';
    this.overlay.addEventListener('click', () => this.hidePanel());

    // 创建面板
    this.panel = document.createElement('div');
    this.panel.className = 'bg-settings-panel';

    const title = document.createElement('h3');
    title.textContent = '背景图片设置';
    title.className = 'bg-settings-title';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'bg-settings-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => this.hidePanel());

    // 图片选择区域
    const imageSection = this.createImageSection();

    // 透明度控制
    const opacitySection = this.createSliderSection(
      '透明度',
      'opacity',
      0,
      1,
      0.01,
      this.settings.opacity,
      (v) => {
        this.settings.opacity = v;
        this.applySettings();
        this.saveSettings();
      }
    );

    // 模糊度控制
    const blurSection = this.createSliderSection(
      '模糊度',
      'blur',
      0,
      20,
      0.5,
      this.settings.blur,
      (v) => {
        this.settings.blur = v;
        this.applySettings();
        this.saveSettings();
      },
      'px'
    );

    // 尺寸选择
    const sizeSection = this.createSizeSection();

    // 显示区域选择
    const positionSection = this.createPositionSection();

    // 重置按钮
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'bg-settings-reset';
    resetBtn.textContent = '重置为默认';
    resetBtn.addEventListener('click', () => {
      this.settings = { ...DEFAULT_SETTINGS };
      this.applySettings();
      this.saveSettings();
      this.updateUI();
    });

    this.panel.append(
      title,
      closeBtn,
      imageSection,
      opacitySection,
      blurSection,
      sizeSection,
      positionSection,
      resetBtn
    );

    document.body.append(this.overlay, this.panel);
  }

  private createImageSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'bg-settings-section';

    const label = document.createElement('label');
    label.textContent = '背景图片';
    label.className = 'bg-settings-label';

    const inputRow = document.createElement('div');
    inputRow.className = 'bg-settings-input-row';

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.className = 'bg-settings-url-input';
    urlInput.placeholder = '输入图片 URL 或选择本地文件...';
    urlInput.value = this.settings.imageUrl;
    urlInput.addEventListener('change', () => {
      this.settings.imageUrl = urlInput.value.trim();
      this.applySettings();
      this.saveSettings();
      this.refreshDragPreview();
    });

    const fileBtn = document.createElement('button');
    fileBtn.type = 'button';
    fileBtn.className = 'bg-settings-file-btn';
    fileBtn.textContent = '选择文件';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = () => {
          this.settings.imageUrl = reader.result as string;
          urlInput.value = this.settings.imageUrl;
          this.applySettings();
          this.saveSettings();
          this.refreshDragPreview();
        };
        reader.readAsDataURL(file);
      }
    });
    fileBtn.addEventListener('click', () => fileInput.click());

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'bg-settings-clear-btn';
    clearBtn.textContent = '清除';
    clearBtn.addEventListener('click', () => {
      this.settings.imageUrl = '';
      urlInput.value = '';
      this.applySettings();
      this.saveSettings();
      this.refreshDragPreview();
    });

    inputRow.append(urlInput, fileBtn, fileInput, clearBtn);
    section.append(label, inputRow);

    return section;
  }

  private createSliderSection(
    labelText: string,
    id: string,
    min: number,
    max: number,
    step: number,
    value: number,
    onChange: (v: number) => void,
    unit: string = ''
  ): HTMLElement {
    const section = document.createElement('div');
    section.className = 'bg-settings-section';

    const label = document.createElement('label');
    label.className = 'bg-settings-label';

    const valueSpan = document.createElement('span');
    valueSpan.className = 'bg-settings-value';
    valueSpan.textContent = `${value}${unit}`;

    label.textContent = `${labelText} `;
    label.appendChild(valueSpan);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'bg-settings-slider';
    slider.id = `bg-${id}`;
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(value);
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      valueSpan.textContent = `${v}${unit}`;
      onChange(v);
    });

    section.append(label, slider);
    return section;
  }

  private createSizeSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'bg-settings-section';

    const label = document.createElement('label');
    label.textContent = '图片尺寸';
    label.className = 'bg-settings-label';

    const btnGroup = document.createElement('div');
    btnGroup.className = 'bg-settings-btn-group';

    const sizes: Array<{ value: BackgroundSettings['size']; label: string }> = [
      { value: 'cover', label: '覆盖' },
      { value: 'contain', label: '适应' },
      { value: 'auto', label: '原始' }
    ];

    sizes.forEach(({ value, label: btnLabel }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bg-settings-size-btn';
      btn.textContent = btnLabel;
      btn.dataset.value = value;
      if (this.settings.size === value) {
        btn.classList.add('active');
      }
      btn.addEventListener('click', () => {
        this.settings.size = value;
        btnGroup
          .querySelectorAll('.bg-settings-size-btn')
          .forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.applySettings();
        this.saveSettings();
        this.layoutDragImage();
      });
      btnGroup.appendChild(btn);
    });

    section.append(label, btnGroup);
    return section;
  }

  private createPositionSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'bg-settings-section';

    const label = document.createElement('label');
    label.className = 'bg-settings-label bg-settings-label-row';
    label.textContent = '显示区域（拖动移动 / 滚轮缩放）';
    const zoomValue = document.createElement('span');
    zoomValue.className = 'bg-settings-zoom-value';
    label.appendChild(zoomValue);
    this.zoomValueEl = zoomValue;

    // 预览框模拟编辑区：图片按 cover/contain/auto 尺寸铺入，拖动选择显示区域，滚轮缩放
    const box = document.createElement('div');
    box.className = 'bg-settings-drag-box';
    this.dragBox = box;

    const img = document.createElement('img');
    img.className = 'bg-settings-drag-img';
    img.alt = '背景图位置预览';
    img.draggable = false; // 自实现 pointer 拖动，避免原生拖拽
    img.hidden = true;
    box.appendChild(img);
    this.dragImg = img;

    const hint = document.createElement('div');
    hint.className = 'bg-settings-drag-hint';
    box.appendChild(hint);
    this.dragHint = hint;

    img.addEventListener('pointerdown', (e) => {
      if (!this.dragOffsets || e.button !== 0) return;
      e.preventDefault();
      img.setPointerCapture(e.pointerId);
      img.classList.add('dragging');
      const startLeft = this.dragOffsets.left;
      const startTop = this.dragOffsets.top;
      const startX = e.clientX;
      const startY = e.clientY;

      const onMove = (ev: PointerEvent) => {
        const { left, top } = this.clampDragOffset(
          startLeft + ev.clientX - startX,
          startTop + ev.clientY - startY
        );
        this.setDragOffset(left, top, true);
      };
      const onUp = (ev: PointerEvent) => {
        img.releasePointerCapture(ev.pointerId);
        img.classList.remove('dragging');
        img.removeEventListener('pointermove', onMove);
        img.removeEventListener('pointerup', onUp);
        img.removeEventListener('pointercancel', onUp);
        this.saveSettings();
      };
      img.addEventListener('pointermove', onMove);
      img.addEventListener('pointerup', onUp);
      img.addEventListener('pointercancel', onUp);
    });

    // 滚轮缩放（preventDefault 防止滚动面板）
    box.addEventListener('wheel', this.onWheelBound, { passive: false });

    section.append(label, box);
    return section;
  }

  /** 滚轮缩放：1~5 倍，作用在 cover/contain/auto 基准尺寸之上 */
  private handleWheel(e: WheelEvent): void {
    if (!this.imgNatural || !this.settings.imageUrl) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const zoom = Math.min(5, Math.max(1, Math.round(this.settings.zoom * factor * 100) / 100));
    if (zoom === this.settings.zoom) return;
    this.settings.zoom = zoom;
    this.applySettings();
    this.layoutDragImage();
    this.saveSettings();
    this.updateZoomValue();
  }

  private updateZoomValue(): void {
    if (this.zoomValueEl) this.zoomValueEl.textContent = `×${this.settings.zoom.toFixed(1)}`;
  }

  private onWheelBound = (e: WheelEvent): void => this.handleWheel(e);

  /** 拖动范围：cover 时图片大于框（左/上 ∈ [框-图, 0]），contain/auto 时图片在框内 */
  private clampDragOffset(left: number, top: number): { left: number; top: number } {
    const box = this.dragBox;
    const img = this.dragImg;
    if (!box || !img) return { left, top };
    const bw = box.clientWidth;
    const bh = box.clientHeight;
    const iw = img.offsetWidth;
    const ih = img.offsetHeight;
    const clamp = (v: number, size: number) =>
      Math.min(Math.max(v, Math.min(0, size)), Math.max(0, size));
    return { left: clamp(left, bw - iw), top: clamp(top, bh - ih) };
  }

  /** 更新图片像素偏移；(sync) 时换算回百分比串写入设置并应用到编辑器 */
  private setDragOffset(left: number, top: number, sync: boolean): void {
    const box = this.dragBox;
    const img = this.dragImg;
    if (!box || !img) return;
    this.dragOffsets = { left, top };
    img.style.left = `${left}px`;
    img.style.top = `${top}px`;
    if (sync) {
      const bw = box.clientWidth;
      const bh = box.clientHeight;
      const iw = img.offsetWidth;
      const ih = img.offsetHeight;
      // background-position 百分比：0% 左对齐、100% 右对齐，与像素偏移线性对应
      const x = bw - iw === 0 ? 50 : (left / (bw - iw)) * 100;
      const y = bh - ih === 0 ? 50 : (top / (bh - ih)) * 100;
      this.settings.position = `${Math.round(x * 100) / 100}% ${Math.round(y * 100) / 100}%`;
      this.applySettings();
    }
  }

  private parsePositionPercent(position: string): { x: number; y: number } {
    const [x, y] = position.split(' ').map((v) => parseFloat(v));
    return { x: Number.isFinite(x) ? x : 50, y: Number.isFinite(y) ? y : 50 };
  }

  /** 按当前尺寸设置重算预览图的大小与偏移（从百分比反算像素） */
  private layoutDragImage(): void {
    const box = this.dragBox;
    const img = this.dragImg;
    if (!box || !img || !this.imgNatural) return;
    const bw = box.clientWidth;
    const bh = box.clientHeight;
    const { w, h } = this.imgNatural;
    let scale =
      this.settings.size === 'cover'
        ? Math.max(bw / w, bh / h)
        : this.settings.size === 'contain'
          ? Math.min(bw / w, bh / h)
          : 1;
    scale *= this.settings.zoom;
    const iw = w * scale;
    const ih = h * scale;
    img.style.width = `${iw}px`;
    img.style.height = `${ih}px`;
    const { x, y } = this.parsePositionPercent(this.settings.position);
    this.setDragOffset((bw - iw) * (x / 100), (bh - ih) * (y / 100), false);
  }

  /** 重新加载预览图并定位（图片 URL/尺寸变化、面板重新打开时调用） */
  private refreshDragPreview(): void {
    const box = this.dragBox;
    const img = this.dragImg;
    const hint = this.dragHint;
    if (!box || !img || !hint) return;
    this.imgNatural = null;
    const url = this.settings.imageUrl;
    if (!url) {
      img.hidden = true;
      hint.textContent = '请先选择背景图片';
      return;
    }
    const probe = new Image();
    probe.onload = () => {
      // 防止快速切换 URL 时旧回包覆盖
      if (probe.src !== this.settings.imageUrl) return;
      this.imgNatural = {
        w: probe.naturalWidth || probe.width,
        h: probe.naturalHeight || probe.height
      };
      img.src = probe.src;
      img.hidden = false;
      hint.textContent = '';
      this.layoutDragImage();
      // 图片尺寸已知后才能算 px 背景尺寸
      this.applySettings();
      this.updateZoomValue();
    };
    probe.onerror = () => {
      img.hidden = true;
      hint.textContent = '图片加载失败';
    };
    probe.src = url;
  }

  private updateUI(): void {
    if (!this.panel) return;

    const urlInput = this.panel.querySelector<HTMLInputElement>('.bg-settings-url-input');
    if (urlInput) {
      urlInput.value = this.settings.imageUrl;
    }

    const opacitySlider = this.panel.querySelector<HTMLInputElement>('#bg-opacity');
    const opacityValue = this.panel
      .querySelector('#bg-opacity')
      ?.parentElement?.querySelector('.bg-settings-value');
    if (opacitySlider) {
      opacitySlider.value = String(this.settings.opacity);
      if (opacityValue) opacityValue.textContent = String(this.settings.opacity);
    }

    const blurSlider = this.panel.querySelector<HTMLInputElement>('#bg-blur');
    const blurValue = this.panel
      .querySelector('#bg-blur')
      ?.parentElement?.querySelector('.bg-settings-value');
    if (blurSlider) {
      blurSlider.value = String(this.settings.blur);
      if (blurValue) blurValue.textContent = `${this.settings.blur}px`;
    }

    this.panel.querySelectorAll('.bg-settings-size-btn').forEach((btn) => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.value === this.settings.size);
    });

    // 每次打开面板按当前设置重新定位预览图（面板只创建一次）
    this.updateZoomValue();
    this.refreshDragPreview();
  }
}
