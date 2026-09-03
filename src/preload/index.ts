import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type { CommandName } from '../shared/ipc';
import type { TypewrenApi } from '../shared/typewren-api';

const api: TypewrenApi = {
  platform: process.platform,

  openFileDialog: () => ipcRenderer.invoke('dialog:open-file'),

  saveFileDialog: (payload) => ipcRenderer.invoke('dialog:save-as', payload),

  writeFile: (payload) => ipcRenderer.invoke('file:write', payload),

  exportDocument: (payload) => ipcRenderer.invoke('export:document', payload),

  saveImageFromPath: (payload) => ipcRenderer.invoke('image:save-from-path', payload),

  saveImageFromData: (payload) => ipcRenderer.invoke('image:save-from-data', payload),

  downloadImage: (payload) => ipcRenderer.invoke('image:download', payload),

  confirmDiscardChanges: () => ipcRenderer.invoke('dialog:discard-changes'),

  setTitle: (title) => ipcRenderer.send('win:set-title', title),

  setNativeTheme: (theme) => ipcRenderer.send('theme:set-native', theme),

  onNativeThemeUpdated: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, dark: boolean): void => callback(dark);
    ipcRenderer.on('theme:native-updated', handler);
    return () => ipcRenderer.off('theme:native-updated', handler);
  },

  setDirty: (dirty) => ipcRenderer.send('win:set-dirty', dirty),

  requestForceClose: () => ipcRenderer.send('win:request-force-close'),

  popupMenu: (label, x, y) => ipcRenderer.send('menu:popup', { label, x, y }),

  onCommand: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, name: string, payload?: unknown): void =>
      callback(name as CommandName, payload);
    ipcRenderer.on('cmd', handler);
    return () => ipcRenderer.off('cmd', handler);
  },

  openFileInNewWindow: (filePath) => ipcRenderer.send('file:open-in-new-window', filePath),

  getPathForFile: (file) => webUtils.getPathForFile(file),

  readFileContent: (filePath) => ipcRenderer.invoke('file:read-content', filePath)
};

contextBridge.exposeInMainWorld('typewren', api);
