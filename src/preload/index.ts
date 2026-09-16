import { contextBridge, ipcRenderer, webUtils } from 'electron';

import { isUpdateDownloadState, type CommandName } from '../shared/ipc';
import type { TypewrenApi } from '../shared/typewren-api';

declare const location: { search: string };

// 启动标志由主进程经页面 URL query 传入（window.ts）：
// 沙箱 preload 里 process.argv/env 不可靠，URL 参数两端一致性最好
function readLaunchParam(name: string): string | null {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}

const api: TypewrenApi = {
  platform: process.platform,

  testMode: readLaunchParam('twtest') === '1',

  draftIntervalMs: readLaunchParam('draft') ?? '',

  openFileDialog: () => ipcRenderer.invoke('dialog:open-file'),

  saveFileDialog: (payload) => ipcRenderer.invoke('dialog:save-as', payload),

  writeFile: (payload) => ipcRenderer.invoke('file:write', payload),

  exportDocument: (payload) => ipcRenderer.invoke('export:document', payload),

  saveImageFromPath: (payload) => ipcRenderer.invoke('image:save-from-path', payload),

  saveImageFromData: (payload) => ipcRenderer.invoke('image:save-from-data', payload),

  downloadImage: (payload) => ipcRenderer.invoke('image:download', payload),

  confirmDiscardChanges: () => ipcRenderer.invoke('dialog:discard-changes'),

  confirmDialog: (payload) => ipcRenderer.invoke('dialog:confirm', payload),

  readFileQuiet: (filePath) => ipcRenderer.invoke('file:read-quiet', filePath),

  listDir: (payload) => ipcRenderer.invoke('dir:list', payload),

  showInFolder: (filePath) => ipcRenderer.send('file:show-in-folder', filePath),

  setSpellcheck: (enabled) => ipcRenderer.send('app:set-spellcheck', enabled),

  onSpellcheckState: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, enabled: boolean): void =>
      callback(enabled);
    ipcRenderer.on('spellcheck:state', handler);
    return () => ipcRenderer.off('spellcheck:state', handler);
  },

  copyAssets: (payload) => ipcRenderer.invoke('assets:copy', payload),

  setTitle: (title) => ipcRenderer.send('win:set-title', title),

  setNativeTheme: (theme) => ipcRenderer.send('theme:set-native', theme),

  onNativeThemeUpdated: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, dark: boolean): void => callback(dark);
    ipcRenderer.on('theme:native-updated', handler);
    return () => ipcRenderer.off('theme:native-updated', handler);
  },

  setDirty: (dirty) => ipcRenderer.send('win:set-dirty', dirty),

  setWindowPath: (path) => ipcRenderer.send('win:set-path', path),

  onUpdateDownloadState: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown): void => {
      if (isUpdateDownloadState(state)) callback(state);
    };
    ipcRenderer.on('updater:download-state', handler);
    return () => ipcRenderer.off('updater:download-state', handler);
  },

  cancelUpdateDownload: () => ipcRenderer.send('updater:cancel-download'),

  requestForceClose: () => ipcRenderer.send('win:request-force-close'),

  popupMenu: (label, x, y) => ipcRenderer.send('menu:popup', { label, x, y }),

  onCommand: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, name: string, payload?: unknown): void =>
      callback(name as CommandName, payload);
    ipcRenderer.on('cmd', handler);
    return () => ipcRenderer.off('cmd', handler);
  },

  openFileInNewWindow: (filePath) => ipcRenderer.send('file:open-in-new-window', filePath),

  takePendingOpen: () => ipcRenderer.invoke('file:take-pending-open'),

  saveDraft: (payload) => ipcRenderer.send('draft:save', payload),

  clearDraft: (path) => ipcRenderer.send('draft:clear', path),

  getPathForFile: (file) => webUtils.getPathForFile(file),

  readFileContent: (filePath) => ipcRenderer.invoke('file:read-content', filePath)
};

contextBridge.exposeInMainWorld('typewren', api);
