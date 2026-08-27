/* ============================================================
 * 亮色 / 暗色主题切换
 * - localStorage 持久化（light / dark / system）
 * - 默认跟随系统偏好，且系统切换时实时联动
 * - 同步到主进程 nativeTheme：标题栏 / 菜单栏 / 原生控件跟随变色
 * ============================================================ */

const STORAGE_KEY = 'typewren.theme'

export type ThemeName = 'light' | 'dark'
type ThemePreference = ThemeName | 'system'

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function readStoredPreference(): ThemePreference {
  const value = localStorage.getItem(STORAGE_KEY)
  return value === 'light' || value === 'dark' || value === 'system'
    ? value
    : 'system'
}

function resolve(preference: ThemePreference): ThemeName {
  if (preference === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return preference
}

function applyToDom(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme
}

/** 原生主题广播订阅就绪后为 true：此后交互切换以主进程为时钟 */
let nativeClockReady = false
/** 跟随原生广播落 DOM 的超时兜底（IPC 丢失时不至于卡在旧配色） */
let fallbackTimer: number | null = null

/** 应用主题并同步原生窗口配色。
 * 启动阶段直接落 DOM（避免首帧闪错色）；交互切换则等主进程
 * nativeTheme 生效广播后再落 DOM，使内容与标题栏/菜单栏同刻变色。 */
export function applyPreference(preference: ThemePreference): ThemeName {
  const resolved = resolve(preference)
  localStorage.setItem(STORAGE_KEY, preference)

  if (!nativeClockReady) {
    applyToDom(resolved)
  } else {
    if (fallbackTimer !== null) clearTimeout(fallbackTimer)
    fallbackTimer = window.setTimeout(() => {
      fallbackTimer = null
      applyToDom(resolved)
    }, 300)
  }

  window.typewren.setNativeTheme(preference)
  return resolved
}

export function currentTheme(): ThemeName {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export function toggleTheme(): ThemeName {
  const next: ThemeName = currentTheme() === 'dark' ? 'light' : 'dark'
  return applyPreference(next)
}

export function initThemeToggle(button: HTMLButtonElement): void {
  const syncButtonLabel = (theme: ThemeName): void => {
    button.textContent = theme === 'dark' ? '☀ 亮色' : '☾ 暗色'
    button.title = theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'
  }

  syncButtonLabel(applyPreference(readStoredPreference()))

  // 以主进程 nativeTheme 为唯一时钟：
  // 跟随系统偏好变化；显式指定 light/dark 时 themeSource 覆盖系统值，不会误触发
  window.typewren.onNativeThemeUpdated((dark) => {
    const resolved: ThemeName = dark ? 'dark' : 'light'
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer)
      fallbackTimer = null
    }
    if (currentTheme() !== resolved) {
      applyToDom(resolved)
      syncButtonLabel(resolved)
    }
  })
  nativeClockReady = true

  button.addEventListener('click', () => {
    syncButtonLabel(toggleTheme())
  })
}
