const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voidcatDesktop", {
  bridgeVersion: 2,
  chooseRagFolder: () => ipcRenderer.invoke("voidcat:choose-rag-folder"),
  credentials: {
    set: (namespace, key, value) => ipcRenderer.invoke("voidcat:credentials:set", namespace, key, value),
    delete: (namespace, key) => ipcRenderer.invoke("voidcat:credentials:delete", namespace, key),
    list: (namespace) => ipcRenderer.invoke("voidcat:credentials:list", namespace),
    test: () => ipcRenderer.invoke("voidcat:credentials:test"),
  },
  maritime: {
    start: (regionIds) => ipcRenderer.invoke("voidcat:maritime:start", regionIds),
    stop: () => ipcRenderer.invoke("voidcat:maritime:stop"),
    snapshot: () => ipcRenderer.invoke("voidcat:maritime:snapshot"),
    setDisplayCadence: (displayCadenceMs) => ipcRenderer.invoke("voidcat:maritime:set-display-cadence", displayCadenceMs),
  },
});
