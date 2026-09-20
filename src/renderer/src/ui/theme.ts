/* ============================================================
 * 亮色 / 暗色主题切换
 * - 权威值在设置存储（settings.json 的 theme 字段，偏好设置窗口可改）
 * - localStorage 保留镜像：首帧同步快路径 + 测试预置；
 *   初始化时镜像存在则以其为准（并随 setNativeTheme 同步回主进程）
 * - 默认跟随系统偏好，且系统切换时实时联动
 * - 同步到主进程 nativeTheme：标题栏 / 菜单栏 / 原生控件跟随变色
 * ============================================================ */

import type { ThemePreference } from '../../../shared/settings';

const STORAGE_KEY = 'typewren.theme';

/** 交互切换后等待主进程 nativeTheme 广播的超时兜底（防止 IPC 丢失卡在旧配色） */
const NATIVE_SYNC_FALLBACK_MS = 300;

export type ThemeName = 'light' | 'dark';

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function readStoredPreference(): ThemePreference | null {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === 'light' || value === 'dark' || value === 'system' ? value : null;
}

function resolve(preference: ThemePreference): ThemeName {
  if (preference === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return preference;
}

function applyToDom(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
}

/** 原生主题广播订阅就绪后为 true：此后交互切换以主进程为时钟 */
let nativeClockReady = false;
/** 跟随原生广播落 DOM 的超时兜底（IPC 丢失时不至于卡在旧配色） */
let fallbackTimer: number | null = null;

/** 最近一次应用过的偏好（环回防抖：settings 广播→applyPreference→settings 同步不会死循环） */
let lastPreference: ThemePreference | null = null;

/** 偏好变化的同步出口（由主装配接到设置存储，用于持久化） */
let preferenceSink: ((preference: ThemePreference) => void) | null = null;

export function setThemePreferenceSink(sink: ((preference: ThemePreference) => void) | null): void {
  preferenceSink = sink;
}

/** 应用主题偏好并同步原生窗口配色。
 * 启动阶段直接落 DOM（避免首帧闪错色）；交互切换则等主进程
 * nativeTheme 生效广播后再落 DOM，使内容与标题栏/菜单栏同刻变色。 */
export function applyPreference(preference: ThemePreference): ThemeName {
  const resolved = resolve(preference);
  // 镜像缓存：首帧快路径 + 旧版 UI 测试兼容（typewren.theme 断言）
  localStorage.setItem(STORAGE_KEY, preference);

  if (preference !== lastPreference) {
    lastPreference = preference;
    preferenceSink?.(preference);
  }

  if (!nativeClockReady) {
    applyToDom(resolved);
  } else {
    if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    fallbackTimer = window.setTimeout(() => {
      fallbackTimer = null;
      applyToDom(resolved);
    }, NATIVE_SYNC_FALLBACK_MS);
  }

  window.typewren.setNativeTheme(preference);
  return resolved;
}

export function currentTheme(): ThemeName {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function toggleTheme(): ThemeName {
  const next: ThemeName = currentTheme() === 'dark' ? 'light' : 'dark';
  return applyPreference(next);
}

export function initThemeToggle(
  button: HTMLButtonElement,
  fallbackPreference: ThemePreference
): void {
  const syncButtonLabel = (theme: ThemeName): void => {
    button.textContent = theme === 'dark' ? '☀ 亮色' : '☾ 暗色';
    button.title = theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题';
  };

  // 镜像（localStorage，含旧版遗留值）优先；settings.json 为权威
  const preference = readStoredPreference() ?? fallbackPreference;
  syncButtonLabel(applyPreference(preference));

  // 以主进程 nativeTheme 为唯一时钟：
  // 跟随系统偏好变化；显式指定 light/dark 时 themeSource 覆盖系统值，不会误触发
  window.typewren.onNativeThemeUpdated((dark) => {
    const resolved: ThemeName = dark ? 'dark' : 'light';
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    if (currentTheme() !== resolved) {
      applyToDom(resolved);
      syncButtonLabel(resolved);
    }
  });
  nativeClockReady = true;

  button.addEventListener('click', () => {
    syncButtonLabel(toggleTheme());
  });
}
