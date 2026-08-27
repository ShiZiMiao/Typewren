/* ============================================================
 * 标题栏配色（主进程侧，供 titleBarOverlay 即时设置）
 * 与渲染层 variables.css 中的 --bg-soft / --text-muted 保持同步：
 * 原生标题栏按钮区底色 = --bg-soft，按钮字形色 = --text-muted。
 * ============================================================ */

export interface TitleBarPalette {
  /** 标题栏按钮区底色（即 titleBarOverlay.color） */
  color: string
  /** 标题栏按钮字形色（即 titleBarOverlay.symbolColor） */
  symbolColor: string
}

export const TITLEBAR_PALETTE: {
  light: TitleBarPalette
  dark: TitleBarPalette
} = {
  light: { color: '#f8f9fb', symbolColor: '#6a737d' },
  dark: { color: '#23282e', symbolColor: '#8b96a3' }
}
