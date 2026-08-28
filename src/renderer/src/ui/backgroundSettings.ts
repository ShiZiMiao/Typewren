/* ============================================================
 * 背景图片设置面板：支持自定义背景图片、透明度、模糊度
 * 设置保存到 localStorage，应用到编辑区域
 * ============================================================ */

const STORAGE_KEY = 'typewren.background'

export interface BackgroundSettings {
  imageUrl: string
  opacity: number
  blur: number
  size: 'cover' | 'contain' | 'auto'
  position: string
}

const DEFAULT_SETTINGS: BackgroundSettings = {
  imageUrl: '',
  opacity: 0.3,
  blur: 0,
  size: 'cover',
  position: 'center'
}

export class BackgroundSettingsController {
  private settings: BackgroundSettings
  private panel: HTMLElement | null = null
  private overlay: HTMLElement | null = null

  constructor() {
    this.settings = this.loadSettings()
    this.applySettings()
  }

  private loadSettings(): BackgroundSettings {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) }
      }
    } catch {
      // 解析失败使用默认值
    }
    return { ...DEFAULT_SETTINGS }
  }

  private saveSettings(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings))
  }

  private applySettings(): void {
    const root = document.documentElement
    const app = document.getElementById('app')

    if (this.settings.imageUrl) {
      root.style.setProperty('--bg-image-url', `url('${this.settings.imageUrl}')`)
      root.style.setProperty('--bg-image-opacity', String(this.settings.opacity))
      root.style.setProperty('--bg-image-blur', `${this.settings.blur}px`)
      root.style.setProperty('--bg-image-size', this.settings.size)
      root.style.setProperty('--bg-image-position', this.settings.position)
      app?.classList.add('has-background')
    } else {
      app?.classList.remove('has-background')
      root.style.removeProperty('--bg-image-url')
      root.style.removeProperty('--bg-image-opacity')
      root.style.removeProperty('--bg-image-blur')
      root.style.removeProperty('--bg-image-size')
      root.style.removeProperty('--bg-image-position')
    }
  }

  togglePanel(): void {
    if (this.panel?.classList.contains('visible')) {
      this.hidePanel()
    } else {
      this.showPanel()
    }
  }

  private showPanel(): void {
    if (!this.panel) {
      this.createPanel()
    }
    this.updateUI()
    this.panel?.classList.add('visible')
    this.overlay?.classList.add('visible')
  }

  hidePanel(): void {
    this.panel?.classList.remove('visible')
    this.overlay?.classList.remove('visible')
  }

  private createPanel(): void {
    // 创建遮罩层
    this.overlay = document.createElement('div')
    this.overlay.className = 'bg-settings-overlay'
    this.overlay.addEventListener('click', () => this.hidePanel())

    // 创建面板
    this.panel = document.createElement('div')
    this.panel.className = 'bg-settings-panel'

    const title = document.createElement('h3')
    title.textContent = '背景图片设置'
    title.className = 'bg-settings-title'

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'bg-settings-close'
    closeBtn.textContent = '×'
    closeBtn.addEventListener('click', () => this.hidePanel())

    // 图片选择区域
    const imageSection = this.createImageSection()

    // 透明度控制
    const opacitySection = this.createSliderSection(
      '透明度',
      'opacity',
      0,
      1,
      0.01,
      this.settings.opacity,
      (v) => {
        this.settings.opacity = v
        this.applySettings()
        this.saveSettings()
      }
    )

    // 模糊度控制
    const blurSection = this.createSliderSection(
      '模糊度',
      'blur',
      0,
      20,
      0.5,
      this.settings.blur,
      (v) => {
        this.settings.blur = v
        this.applySettings()
        this.saveSettings()
      },
      'px'
    )

    // 尺寸选择
    const sizeSection = this.createSizeSection()

    // 重置按钮
    const resetBtn = document.createElement('button')
    resetBtn.type = 'button'
    resetBtn.className = 'bg-settings-reset'
    resetBtn.textContent = '重置为默认'
    resetBtn.addEventListener('click', () => {
      this.settings = { ...DEFAULT_SETTINGS }
      this.applySettings()
      this.saveSettings()
      this.updateUI()
    })

    this.panel.append(
      title,
      closeBtn,
      imageSection,
      opacitySection,
      blurSection,
      sizeSection,
      resetBtn
    )

    document.body.append(this.overlay, this.panel)
  }

  private createImageSection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'bg-settings-section'

    const label = document.createElement('label')
    label.textContent = '背景图片'
    label.className = 'bg-settings-label'

    const inputRow = document.createElement('div')
    inputRow.className = 'bg-settings-input-row'

    const urlInput = document.createElement('input')
    urlInput.type = 'text'
    urlInput.className = 'bg-settings-url-input'
    urlInput.placeholder = '输入图片 URL 或选择本地文件...'
    urlInput.value = this.settings.imageUrl
    urlInput.addEventListener('change', () => {
      this.settings.imageUrl = urlInput.value.trim()
      this.applySettings()
      this.saveSettings()
    })

    const fileBtn = document.createElement('button')
    fileBtn.type = 'button'
    fileBtn.className = 'bg-settings-file-btn'
    fileBtn.textContent = '选择文件'

    const fileInput = document.createElement('input')
    fileInput.type = 'file'
    fileInput.accept = 'image/*'
    fileInput.style.display = 'none'
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0]
      if (file) {
        const reader = new FileReader()
        reader.onload = () => {
          this.settings.imageUrl = reader.result as string
          urlInput.value = this.settings.imageUrl
          this.applySettings()
          this.saveSettings()
        }
        reader.readAsDataURL(file)
      }
    })
    fileBtn.addEventListener('click', () => fileInput.click())

    const clearBtn = document.createElement('button')
    clearBtn.type = 'button'
    clearBtn.className = 'bg-settings-clear-btn'
    clearBtn.textContent = '清除'
    clearBtn.addEventListener('click', () => {
      this.settings.imageUrl = ''
      urlInput.value = ''
      this.applySettings()
      this.saveSettings()
    })

    inputRow.append(urlInput, fileBtn, fileInput, clearBtn)
    section.append(label, inputRow)

    return section
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
    const section = document.createElement('div')
    section.className = 'bg-settings-section'

    const label = document.createElement('label')
    label.className = 'bg-settings-label'

    const valueSpan = document.createElement('span')
    valueSpan.className = 'bg-settings-value'
    valueSpan.textContent = `${value}${unit}`

    label.textContent = `${labelText} `
    label.appendChild(valueSpan)

    const slider = document.createElement('input')
    slider.type = 'range'
    slider.className = 'bg-settings-slider'
    slider.id = `bg-${id}`
    slider.min = String(min)
    slider.max = String(max)
    slider.step = String(step)
    slider.value = String(value)
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value)
      valueSpan.textContent = `${v}${unit}`
      onChange(v)
    })

    section.append(label, slider)
    return section
  }

  private createSizeSection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'bg-settings-section'

    const label = document.createElement('label')
    label.textContent = '图片尺寸'
    label.className = 'bg-settings-label'

    const btnGroup = document.createElement('div')
    btnGroup.className = 'bg-settings-btn-group'

    const sizes: Array<{ value: BackgroundSettings['size']; label: string }> = [
      { value: 'cover', label: '覆盖' },
      { value: 'contain', label: '适应' },
      { value: 'auto', label: '原始' }
    ]

    sizes.forEach(({ value, label: btnLabel }) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'bg-settings-size-btn'
      btn.textContent = btnLabel
      btn.dataset.value = value
      if (this.settings.size === value) {
        btn.classList.add('active')
      }
      btn.addEventListener('click', () => {
        this.settings.size = value
        btnGroup.querySelectorAll('.bg-settings-size-btn').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        this.applySettings()
        this.saveSettings()
      })
      btnGroup.appendChild(btn)
    })

    section.append(label, btnGroup)
    return section
  }

  private updateUI(): void {
    if (!this.panel) return

    const urlInput = this.panel.querySelector<HTMLInputElement>('.bg-settings-url-input')
    if (urlInput) {
      urlInput.value = this.settings.imageUrl
    }

    const opacitySlider = this.panel.querySelector<HTMLInputElement>('#bg-opacity')
    const opacityValue = this.panel.querySelector('#bg-opacity')?.parentElement?.querySelector('.bg-settings-value')
    if (opacitySlider) {
      opacitySlider.value = String(this.settings.opacity)
      if (opacityValue) opacityValue.textContent = String(this.settings.opacity)
    }

    const blurSlider = this.panel.querySelector<HTMLInputElement>('#bg-blur')
    const blurValue = this.panel.querySelector('#bg-blur')?.parentElement?.querySelector('.bg-settings-value')
    if (blurSlider) {
      blurSlider.value = String(this.settings.blur)
      if (blurValue) blurValue.textContent = `${this.settings.blur}px`
    }

    this.panel.querySelectorAll('.bg-settings-size-btn').forEach(btn => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.value === this.settings.size)
    })
  }
}
