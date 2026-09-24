/* ============================================================
 * 应用设置（偏好设置窗口）：字段 / 默认值 / 校验
 * 主进程持久化 userData/settings.json（仿 session/recent 的读写模式），
 * 渲染层经 IPC 读取与修改，改动由主进程广播 settings:updated 到全部窗口。
 * theme / spellcheck / autoPairs 同时保留 localStorage 镜像
 * （首帧快路径 + 测试预置），settings.json 为权威。
 * ============================================================ */

/** 主题偏好：亮 / 暗 / 跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system';

export interface AppSettings {
  /** 编辑器字体族；空串 = 系统默认（继承 body 字体栈） */
  fontFamily: string;
  /** 编辑器正文字号（px） */
  fontSize: number;
  /** 行距（倍率） */
  lineHeight: number;
  /** 编辑区内容宽度（px，实际渲染再套 min(90vw, Npx)） */
  editorWidth: number;
  /** 默认主题（system = 跟随系统） */
  theme: ThemePreference;
  /** 自动保存：定时把脏文档写盘 */
  autoSave: boolean;
  /** 自动保存间隔（秒） */
  autoSaveInterval: number;
  /** 拼写检查 */
  spellcheck: boolean;
  /** 崩溃恢复草稿落盘间隔（秒） */
  draftInterval: number;
  /** 成对符号补全 */
  autoPairs: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  fontFamily: '',
  fontSize: 16,
  lineHeight: 1.75,
  editorWidth: 1200,
  theme: 'system',
  autoSave: false,
  autoSaveInterval: 60,
  spellcheck: false,
  draftInterval: 30,
  autoPairs: true
};

/** 各数值字段的合法区间（对话框与 sanitize 共用） */
export const SETTINGS_LIMITS = {
  fontSize: { min: 12, max: 32 },
  lineHeight: { min: 1.0, max: 3.0 },
  editorWidth: { min: 320, max: 2400 },
  autoSaveInterval: { min: 5, max: 600 },
  draftInterval: { min: 5, max: 600 }
} as const;

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function num(value: unknown, fallback: number): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    // 空串/空白串经 Number('') 会变 0（输入框被清空后回写即此场景），
    // 应视为"未填"回落默认值，而不是把字号/行距钳到下限
    const trimmed = value.trim();
    if (trimmed === '') return fallback;
    return Number(trimmed);
  }
  return fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 把任意来源（磁盘 JSON / 渲染层 IPC 载荷）归一化为合法设置：
 * 未知字段丢弃、数值越界钳制、类型错误回落默认值。
 */
export function sanitizeSettings(value: unknown): AppSettings {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const L = SETTINGS_LIMITS;
  return {
    fontFamily:
      typeof raw.fontFamily === 'string'
        ? raw.fontFamily.trim().slice(0, 200)
        : DEFAULT_SETTINGS.fontFamily,
    fontSize: clamp(
      num(raw.fontSize, DEFAULT_SETTINGS.fontSize),
      L.fontSize.min,
      L.fontSize.max,
      DEFAULT_SETTINGS.fontSize
    ),
    lineHeight: clamp(
      num(raw.lineHeight, DEFAULT_SETTINGS.lineHeight),
      L.lineHeight.min,
      L.lineHeight.max,
      DEFAULT_SETTINGS.lineHeight
    ),
    editorWidth: clamp(
      num(raw.editorWidth, DEFAULT_SETTINGS.editorWidth),
      L.editorWidth.min,
      L.editorWidth.max,
      DEFAULT_SETTINGS.editorWidth
    ),
    theme:
      raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system'
        ? raw.theme
        : DEFAULT_SETTINGS.theme,
    autoSave: bool(raw.autoSave, DEFAULT_SETTINGS.autoSave),
    autoSaveInterval: clamp(
      num(raw.autoSaveInterval, DEFAULT_SETTINGS.autoSaveInterval),
      L.autoSaveInterval.min,
      L.autoSaveInterval.max,
      DEFAULT_SETTINGS.autoSaveInterval
    ),
    spellcheck: bool(raw.spellcheck, DEFAULT_SETTINGS.spellcheck),
    draftInterval: clamp(
      num(raw.draftInterval, DEFAULT_SETTINGS.draftInterval),
      L.draftInterval.min,
      L.draftInterval.max,
      DEFAULT_SETTINGS.draftInterval
    ),
    autoPairs: bool(raw.autoPairs, DEFAULT_SETTINGS.autoPairs)
  };
}

/** 设置对话框的字体预设（value 直接作为 CSS font-family 值） */
export const FONT_PRESETS: { label: string; value: string }[] = [
  { label: '系统默认', value: '' },
  { label: '微软雅黑', value: "'Microsoft YaHei', 'PingFang SC', sans-serif" },
  { label: '苹方（PingFang SC）', value: "'PingFang SC', 'Microsoft YaHei', sans-serif" },
  { label: '宋体', value: "SimSun, 'Songti SC', serif" },
  { label: '楷体', value: "KaiTi, 'STKaiti', serif" },
  { label: 'Times New Roman', value: "'Times New Roman', Times, serif" },
  { label: 'Georgia（衬线）', value: "Georgia, 'Times New Roman', serif" },
  { label: '等宽（Consolas）', value: "Consolas, 'Courier New', monospace" },
  { label: '等宽（JetBrains Mono）', value: "'JetBrains Mono', Consolas, monospace" }
];
