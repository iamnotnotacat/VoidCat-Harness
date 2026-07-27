const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voidcatDesktop", {
  chooseRagFolder: () => ipcRenderer.invoke("voidcat:choose-rag-folder"),
});
