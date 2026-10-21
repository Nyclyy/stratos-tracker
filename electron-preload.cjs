const { contextBridge, ipcRenderer } = require('electron');

// Keep this surface deliberately small. The renderer can observe and control
// only the bridge process; it has no filesystem, shell or arbitrary IPC access.
contextBridge.exposeInMainWorld('stratosDesktop', {
  getStatus: () => ipcRenderer.invoke('bridge:status'),
  restartBridge: () => ipcRenderer.invoke('bridge:restart'),
  stopBridge: () => ipcRenderer.invoke('bridge:stop'),
  getDiagnostics: () => ipcRenderer.invoke('bridge:diagnostics'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  // Verified in the main process against the configured licence service.
  getEntitlement: () => ipcRenderer.invoke('premium:status'),
  getUpdateStatus: () => ipcRenderer.invoke('updater:status'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  // Download progress and verification results, pushed from the main process.
  // The payload is the same status object as getUpdateStatus().
  onUpdateProgress: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (event, status) => callback(status);
    ipcRenderer.on('updater:event', listener);
    return () => ipcRenderer.removeListener('updater:event', listener);
  },
  onStatus: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (event, status) => callback(status);
    ipcRenderer.on('bridge:status', listener);
    return () => ipcRenderer.removeListener('bridge:status', listener);
  },
});
