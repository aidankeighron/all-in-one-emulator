const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    pickFolder: () => ipcRenderer.invoke('pick-folder'),
    pickFile: filterName => ipcRenderer.invoke('pick-file', filterName),
    openExternal: url => ipcRenderer.invoke('open-external', url),
    openPath: dir => ipcRenderer.invoke('open-path', dir)
});
