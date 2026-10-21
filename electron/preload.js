const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    separatePause: true,      // the pause menu has its own window
    pickFolder: () => ipcRenderer.invoke('pick-folder'),
    pickFile: filterName => ipcRenderer.invoke('pick-file', filterName),
    openExternal: url => ipcRenderer.invoke('open-external', url),
    openPath: dir => ipcRenderer.invoke('open-path', dir)
});
