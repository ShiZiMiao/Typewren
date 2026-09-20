import { AppSettings, DEFAULT_SETTINGS, sanitizeSettings } from '../../../shared/settings';
import { applyPreference } from '@/ui/theme';

/* ============================================================
 * 应用设置（渲染进程侧）：单一状态源 + 即时应用
 * - loadAppSettings 从主进程读取，并把 legacy localStorage 值一次性迁移进来；
 * - updateAppSettings 立即应用（幂等）并发送主进程持久化+广播；
 * - 主进程广播 settings:updated → 本窗口/其它窗口重新应用（多窗口一致）。
 * 主题单独走 ui/theme 的 nativeTheme 时钟（决策 #6），其它能力
 *（拼写/成对符号/自动保存/草稿间隔）经 registerCapabilityAppliers 注入生效点。
 * ============================================================ */

let current: AppSettings = { ...DEFAULT_SETTINGS };
const listeners = new Set<() => void>();
let appliers: CapabilityAppliers | null = null;

export interface CapabilityAppliers {
  spellcheck(enabled: boolean): void;
  autoPairs(enabled: boolean): void;
  autoSave(enabled: boolean, intervalSec: number): void;
  draftInterval(sec: number): void;
}

/* ---------- legacy localStorage 一次性迁移（升级用户保留原偏好） ---------- */
const MIGRATED_MARKER = 'typewren.legacy-migrated';
const LEGACY_KEYS = {
  theme: 'typewren.theme',
  spellcheck: 'typewren.spellcheck',
  autoPairs: 'typewren.auto-pairs'
} as const;

function migrateLegacySettings(): Partial<AppSettings> | null {
  if (localStorage.getItem(MIGRATED_MARKER) === '1') return null;
  const patch: Partial<AppSettings> = {};
  const theme = localStorage.getItem(LEGACY_KEYS.theme);
  if (theme === 'light' || theme === 'dark' || theme === 'system') patch.theme = theme;
  const spellcheck = localStorage.getItem(LEGACY_KEYS.spellcheck);
  if (spellcheck === '1' || spellcheck === '0') patch.spellcheck = spellcheck === '1';
  const autoPairs = localStorage.getItem(LEGACY_KEYS.autoPairs);
  if (autoPairs === '0') patch.autoPairs = false;
  // 镜像缓存保留（供测试预置/首帧快路径），只做一次性迁移标记
  localStorage.setItem(MIGRATED_MARKER, '1');
  return Object.keys(patch).length > 0 ? patch : null;
}

/* ---------- 排版 CSS 变量（即时生效） ---------- */
function applyTypography(s: AppSettings): void {
  const st = document.documentElement.style;
  if (s.fontFamily) {
    st.setProperty('--editor-font-family', s.fontFamily);
  } else {
    // 未设置时回退继承 body 字体（变量置空会使 font-family 声明失效 → unset → 继承）
    st.removeProperty('--editor-font-family');
  }
  st.setProperty('--editor-font-size', `${s.fontSize}px`);
  st.setProperty('--editor-line-height', String(s.lineHeight));
  st.setProperty('--editor-max-width', `min(90vw, ${s.editorWidth}px)`);
}

function applyCapabilities(s: AppSettings): void {
  if (!appliers) return;
  appliers.spellcheck(s.spellcheck);
  appliers.autoPairs(s.autoPairs);
  appliers.autoSave(s.autoSave, s.autoSaveInterval);
  appliers.draftInterval(s.draftInterval);
}

function applyAll(s: AppSettings, themeChanged: boolean): void {
  applyTypography(s);
  applyCapabilities(s);
  if (themeChanged) applyPreference(s.theme);
}

function emit(): void {
  for (const fn of listeners) fn();
}

export function getAppSettings(): AppSettings {
  return current;
}

export function updateAppSettings(patch: Partial<AppSettings>): void {
  const prev = current;
  const next = sanitizeSettings({ ...current, ...patch });
  // 值未变直接返回：theme.ts 的 sink 环回、对话框重复输入等不产生无谓 IPC/广播
  if (JSON.stringify(next) === JSON.stringify(prev)) return;
  current = next;
  applyAll(current, current.theme !== prev.theme);
  window.typewren.setSettings(current);
  emit();
}

export function subscribeAppSettings(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** 注入能力生效点（编辑器/文件服务创建完成后调用）。
 * spellcheck/autoPairs 的初始值由各自控制器构造器按"localStorage 镜像优先"
 * 规则读取（测试预置依赖），这里不重复应用；只重新武装需要按设置启动的定时器。 */
export function registerCapabilityAppliers(a: CapabilityAppliers): void {
  appliers = a;
  appliers.autoSave(current.autoSave, current.autoSaveInterval);
  appliers.draftInterval(current.draftInterval);
}

/** 启动时读取设置（须早于 createEditor：首帧排版/主题即正确） */
export async function loadAppSettings(): Promise<AppSettings> {
  window.typewren.onSettingsUpdated((s) => {
    const prev = current;
    current = s;
    applyAll(current, current.theme !== prev.theme);
    emit();
  });
  current = sanitizeSettings(await window.typewren.getSettings());
  const legacy = migrateLegacySettings();
  if (legacy) {
    current = sanitizeSettings({ ...current, ...legacy });
    // 主进程持久化并广播；主题/拼写的 native 侧副作用随之生效
    window.typewren.setSettings(current);
  }
  applyTypography(current);
  return current;
}
