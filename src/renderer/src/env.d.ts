export {}

export interface OpenFileResult {
  path: string
  content: string
}

export interface SaveAsResult {
  path: string
}

export interface TypewrenApi {
  readonly platform: string

  openFileDialog(): Promise<OpenFileResult | null>

  saveFileDialog(payload: {
    content: string
    suggestedName?: string
  }): Promise<SaveAsResult | null>

  writeFile(payload: { path: string; content: string }): Promise<boolean>

  confirmDiscardChanges(): Promise<'save' | 'discard' | 'cancel'>

  setTitle(title: string): void

  setNativeTheme(theme: 'light' | 'dark' | 'system'): void

  onNativeThemeUpdated(callback: (dark: boolean) => void): () => void

  setDirty(dirty: boolean): void

  requestForceClose(): void

  onCommand(callback: (name: string, payload?: unknown) => void): () => void
}

declare global {
  interface Window {
    typewren: TypewrenApi
  }
}
