const { contextBridge, ipcRenderer } = require('electron');

// Keep this surface deliberately small. The renderer can observe and control
// only the bridge process; it has no filesystem, shell or arbitrary IPC access.
contextBridge.exposeInMainWorld('stratosDesktop', {
  getStatus: () => ipcRenderer.invoke('bridge:status'),
  restartBridge: () => ipcRenderer.invoke('bridge:restart'),
  stopBridge: () => ipcRenderer.invoke('bridge:stop'),
  getDiagnostics: () => ipcRenderer.invoke('bridge:diagnostics'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  getUpdateStatus: () => ipcRenderer.invoke('updater:status'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onStatus: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (event, status) => callback(status);
    ipcRenderer.on('bridge:status', listener);
    return () => ipcRenderer.removeListener('bridge:status', listener);
  },
});
