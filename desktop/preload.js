const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  isDesktop: true,
  pickFolder: () => ipcRenderer.invoke('desktop:pickFolder'),
  pickFile: () => ipcRenderer.invoke('desktop:pickFile'),
  saveDoc: (dir, fileName, data) => ipcRenderer.invoke('desktop:saveDoc', dir, fileName, data),
  listDocs: (dir) => ipcRenderer.invoke('desktop:listDocs', dir),
  showInFolder: (filePath) => ipcRenderer.invoke('desktop:showInFolder', filePath),
});
