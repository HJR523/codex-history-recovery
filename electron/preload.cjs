const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('historyRecovery', {
  selectFolder: () => ipcRenderer.invoke('history-recovery:select-folder'),
  selectExportFile: () => ipcRenderer.invoke('history-recovery:select-export-file'),
  selectImportFile: () => ipcRenderer.invoke('history-recovery:select-import-file'),
});

window.addEventListener('DOMContentLoaded', () => {});
