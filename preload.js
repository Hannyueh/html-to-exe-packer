const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Dialog operations ───────────────────────────────────────────
  selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
  selectOutput: () => ipcRenderer.invoke('dialog:select-output'),
  selectIcon: () => ipcRenderer.invoke('dialog:select-icon'),

  // ── Build operations ────────────────────────────────────────────
  startBuild: (config) => ipcRenderer.invoke('build:start', config),
  cancelBuild: () => ipcRenderer.invoke('build:cancel'),

  // ── Event listeners (each returns an unsubscribe function) ──────
  onBuildProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('build:progress', handler);
    return () => ipcRenderer.removeListener('build:progress', handler);
  },
  onBuildStdout: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('build:stdout', handler);
    return () => ipcRenderer.removeListener('build:stdout', handler);
  },
  onBuildStderr: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('build:stderr', handler);
    return () => ipcRenderer.removeListener('build:stderr', handler);
  },
  onBuildComplete: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('build:complete', handler);
    return () => ipcRenderer.removeListener('build:complete', handler);
  },
  onBuildError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('build:error', handler);
    return () => ipcRenderer.removeListener('build:error', handler);
  },
});

