/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voidcatDesktop", {
  bridgeVersion: 8,
  external: {
    open: (url) => ipcRenderer.invoke("voidcat:external:open", url),
  },
  docs: {
    openHowToUse: () => ipcRenderer.invoke("voidcat:docs:open-how-to-use"),
  },
  chooseRagFolder: () => ipcRenderer.invoke("voidcat:choose-rag-folder"),
  models: {
    status: () => ipcRenderer.invoke("voidcat:models:status"),
    choosePrimaryFolder: () => ipcRenderer.invoke("voidcat:models:choose-primary-folder"),
    chooseScanFolder: () => ipcRenderer.invoke("voidcat:models:choose-scan-folder"),
    removeScanFolder: (folder) => ipcRenderer.invoke("voidcat:models:remove-scan-folder", folder),
    scan: (input) => ipcRenderer.invoke("voidcat:models:scan", input),
    cancelScan: () => ipcRenderer.invoke("voidcat:models:cancel-scan"),
  },
  credentials: {
    set: (namespace, key, value) => ipcRenderer.invoke("voidcat:credentials:set", namespace, key, value),
    delete: (namespace, key) => ipcRenderer.invoke("voidcat:credentials:delete", namespace, key),
    list: (namespace) => ipcRenderer.invoke("voidcat:credentials:list", namespace),
    describe: (namespace, key) => ipcRenderer.invoke("voidcat:credentials:describe", namespace, key),
    test: () => ipcRenderer.invoke("voidcat:credentials:test"),
  },
  maritime: {
    testCredential: (credential, regionIds) => ipcRenderer.invoke("voidcat:maritime:test-credential", credential, regionIds),
    testSavedCredential: (regionIds) => ipcRenderer.invoke("voidcat:maritime:test-saved-credential", regionIds),
    start: (regionIds) => ipcRenderer.invoke("voidcat:maritime:start", regionIds),
    disable: () => ipcRenderer.invoke("voidcat:maritime:disable"),
    stop: () => ipcRenderer.invoke("voidcat:maritime:stop"),
    snapshot: () => ipcRenderer.invoke("voidcat:maritime:snapshot"),
    setDisplayCadence: (displayCadenceMs) => ipcRenderer.invoke("voidcat:maritime:set-display-cadence", displayCadenceMs),
  },
  webcams: {
    status: () => ipcRenderer.invoke("voidcat:webcams:status"),
    configure: (credential) => ipcRenderer.invoke("voidcat:webcams:configure", credential),
    remove: () => ipcRenderer.invoke("voidcat:webcams:remove"),
    loadRegion: (regionId) => ipcRenderer.invoke("voidcat:webcams:load-region", regionId),
  },
  windyWebcams: {
    status: () => ipcRenderer.invoke("voidcat:windy-webcams:status"),
    configure: (credential) => ipcRenderer.invoke("voidcat:windy-webcams:configure", credential),
    remove: () => ipcRenderer.invoke("voidcat:windy-webcams:remove"),
    loadRegion: (regionId) => ipcRenderer.invoke("voidcat:windy-webcams:load-region", regionId),
  },
  osint: {
    status: () => ipcRenderer.invoke("voidcat:osint:status"),
    configure: (providerId, values) => ipcRenderer.invoke("voidcat:osint:configure", providerId, values),
    remove: (providerId) => ipcRenderer.invoke("voidcat:osint:remove", providerId),
    test: (providerId) => ipcRenderer.invoke("voidcat:osint:test", providerId),
  },
  voice: {
    status: () => ipcRenderer.invoke("voidcat:voice:status"),
    chooseExecutable: () => ipcRenderer.invoke("voidcat:voice:choose-executable"),
    chooseModel: () => ipcRenderer.invoke("voidcat:voice:choose-model"),
    transcribe: (audioBytes) => ipcRenderer.invoke("voidcat:voice:transcribe", audioBytes),
    speak: (input) => ipcRenderer.invoke("voidcat:voice:speak", input),
    stop: () => ipcRenderer.invoke("voidcat:voice:stop"),
  },
  lan: {
    status: () => ipcRenderer.invoke("voidcat:lan:status"),
    configure: (enabled) => ipcRenderer.invoke("voidcat:lan:configure", enabled),
  },
});
