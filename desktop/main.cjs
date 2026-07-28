const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require("electron");
const { spawn, execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { SecureCredentialStore } = require("./secure-credential-store.cjs");
const { AisstreamMaritimeService } = require("./aisstream-maritime-service.cjs");

const APP_PORT = 4177;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const projectRoot = path.resolve(__dirname, "..");
const iconPath = path.join(projectRoot, "assets", "voidcat.ico");
const runtimeDirectory = path.join(projectRoot, ".voidcat");
const lmsPath = path.join(process.env.USERPROFILE || "", ".lmstudio", "bin", "lms.exe");
const desktopToken = randomUUID();
let mainWindow = null;
let serverProcess = null;
let isQuitting = false;
let hasCleanedUp = false;
let credentialStore = null;
let maritimeService = null;
let maritimePublishTimer = null;
let maritimePublishActive = false;

function writeRendererDiagnostic(kind, details) {
  try {
    fs.mkdirSync(runtimeDirectory, { recursive: true });
    const logPath = path.join(runtimeDirectory, "renderer-error.log");
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 256 * 1024) fs.writeFileSync(logPath, "");
    const safeDetails = String(details ?? "").replace(/[\r\n]+/g, " ").slice(0, 4_000);
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${kind} ${safeDetails}\n`, "utf8");
  } catch {
    // Diagnostics must never interfere with the desktop renderer.
  }
}

function requestReady() {
  return new Promise((resolve) => {
    const request = http.get(`${APP_URL}/api/health`, { timeout: 1_000 }, (response) => {
      const chunks = [];
      let receivedBytes = 0;
      response.on("data", (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes <= 4096) chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const health = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(response.statusCode === 200 && health.app === "voidcat-harness" && health.token === desktopToken);
        } catch { resolve(false); }
      });
    });
    request.on("timeout", () => { request.destroy(); resolve(false); });
    request.on("error", () => resolve(false));
  });
}

function findNode() {
  const programFilesNode = path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe");
  if (fs.existsSync(programFilesNode)) return programFilesNode;
  const result = execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe"), ["node.exe"], { encoding: "utf8", windowsHide: true });
  return result.split(/\r?\n/).find(Boolean);
}

function ejectVoidCatModel() {
  if (!fs.existsSync(lmsPath)) return;
  for (const identifier of ["voidcat-core", "voidcat-embed"]) {
    try {
      execFileSync(lmsPath, ["unload", identifier], {
        cwd: path.dirname(lmsPath), timeout: 120_000, windowsHide: true, stdio: "ignore",
      });
    } catch {
      // The owned model was already unloaded or the headless runtime is unavailable.
    }
  }
}

function cleanupLocalResources() {
  if (hasCleanedUp) return;
  hasCleanedUp = true;
  if (maritimePublishTimer) clearInterval(maritimePublishTimer);
  maritimePublishTimer = null;
  maritimeService?.stop();
  ejectVoidCatModel();
  if (serverProcess && serverProcess.exitCode === null) serverProcess.kill();
}

async function publishMaritimeSnapshot() {
  if (!maritimeService || maritimePublishActive || !serverProcess || serverProcess.exitCode !== null) return;
  maritimePublishActive = true;
  try {
    const snapshot = maritimeService.snapshot();
    const body = JSON.stringify(snapshot);
    if (Buffer.byteLength(body) > 4_000_000) return;
    await fetch(`${APP_URL}/api/hunter-seeker/desktop/maritime-snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VoidCat-Desktop-Token": desktopToken },
      body,
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    // The next bounded publish pass retries; AIS collection remains isolated.
  } finally {
    maritimePublishActive = false;
  }
}

async function ensureLocalService() {
  if (await requestReady()) return;
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  const output = fs.openSync(path.join(runtimeDirectory, "desktop-server.log"), "a");
  const error = fs.openSync(path.join(runtimeDirectory, "desktop-server-error.log"), "a");
  serverProcess = spawn(findNode(), ["--use-system-ca", path.join("node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(APP_PORT)], {
    cwd: projectRoot,
    env: { ...process.env, VOIDCAT_DESKTOP_TOKEN: desktopToken },
    windowsHide: true,
    stdio: ["ignore", output, error],
  });

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await requestReady()) return;
    if (serverProcess.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("The local VoidCat service did not become ready. Check .voidcat/desktop-server-error.log for details.");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "VoidCat Harness",
    icon: iconPath,
    width: 1460,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#07070a",
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#bbff36",
      symbolColor: "#6e35a8",
      height: 32,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      partition: "voidcat-ephemeral",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadURL(APP_URL);
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(APP_URL)) event.preventDefault();
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    writeRendererDiagnostic("render-process-gone", `${details.reason} exit=${details.exitCode}`);
  });
  mainWindow.webContents.on("unresponsive", () => writeRendererDiagnostic("unresponsive", "renderer stopped responding"));
  mainWindow.webContents.on("console-message", (_event, detailsOrLevel, legacyMessage) => {
    if (detailsOrLevel && typeof detailsOrLevel === "object") {
      if (detailsOrLevel.level === "error") writeRendererDiagnostic("console-error", detailsOrLevel.message);
      return;
    }
    if (Number(detailsOrLevel) >= 2) writeRendererDiagnostic("console-error", legacyMessage);
  });
  mainWindow.on("close", cleanupLocalResources);
  mainWindow.on("closed", () => { mainWindow = null; app.exit(0); });
}

ipcMain.handle("voidcat:choose-rag-folder", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Register a RAG folder",
    properties: ["openDirectory"],
  });
  return result.canceled ? null : result.filePaths[0] || null;
});

function requireCredentialStore() {
  if (!credentialStore) throw new Error("Secure credential storage is not initialized.");
  return credentialStore;
}

function savedMaritimeCoverage(store = requireCredentialStore()) {
  const fallback = ["gulf-of-mexico"];
  const supported = new Set(["gulf-of-mexico", "north-america-east", "north-america-west", "north-atlantic", "mediterranean", "baltic", "southeast-asia"]);
  const serialized = store.get("vc-hunter-seeker.aisstream", "coverage-regions");
  if (!serialized) return fallback;
  try {
    const parsed = JSON.parse(serialized);
    return Array.isArray(parsed) && supported.has(parsed[0]) ? [parsed[0]] : fallback;
  } catch {
    return fallback;
  }
}

function savedMaritimeDisplayCadence(store = requireCredentialStore()) {
  const parsed = Number(store.get("vc-hunter-seeker.aisstream", "display-cadence-ms"));
  return Number.isFinite(parsed) && parsed >= 30_000 && parsed <= 12 * 60 * 60_000 ? parsed : 2 * 60_000;
}

ipcMain.handle("voidcat:credentials:set", (_event, namespace, key, value) => requireCredentialStore().set(namespace, key, value));
ipcMain.handle("voidcat:credentials:delete", (_event, namespace, key) => requireCredentialStore().delete(namespace, key));
ipcMain.handle("voidcat:credentials:list", (_event, namespace) => requireCredentialStore().list(namespace));
ipcMain.handle("voidcat:credentials:test", () => requireCredentialStore().test());
ipcMain.handle("voidcat:maritime:start", async (_event, regionIds) => {
  if (!maritimeService) throw new Error("Maritime service is not initialized.");
  const selectedRegions = Array.isArray(regionIds) && regionIds.length
    ? regionIds
    : savedMaritimeCoverage();
  const snapshot = await maritimeService.start(selectedRegions);
  requireCredentialStore().set("vc-hunter-seeker.aisstream", "coverage-regions", JSON.stringify(snapshot.regionIds));
  void publishMaritimeSnapshot();
  return snapshot;
});
ipcMain.handle("voidcat:maritime:stop", () => { const snapshot = maritimeService?.stop(); void publishMaritimeSnapshot(); return snapshot; });
ipcMain.handle("voidcat:maritime:disable", () => { const snapshot = maritimeService?.disable(); void publishMaritimeSnapshot(); return snapshot; });
ipcMain.handle("voidcat:maritime:snapshot", () => maritimeService?.snapshot());
ipcMain.handle("voidcat:maritime:set-display-cadence", (_event, displayCadenceMs) => {
  if (!maritimeService) throw new Error("Maritime service is not initialized.");
  const snapshot = maritimeService.setDisplayCadence(displayCadenceMs);
  requireCredentialStore().set("vc-hunter-seeker.aisstream", "display-cadence-ms", String(snapshot.displayCadenceMs));
  void publishMaritimeSnapshot();
  return snapshot;
});

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      credentialStore = new SecureCredentialStore({
        safeStorage,
        filePath: path.join(runtimeDirectory, "secure-credentials.json"),
      });
      credentialStore.test();
      maritimeService = new AisstreamMaritimeService({
        getCredential: () => credentialStore.get("vc-hunter-seeker.aisstream", "websocket-token"),
        defaultRegionIds: savedMaritimeCoverage(credentialStore),
        defaultDisplayCadenceMs: savedMaritimeDisplayCadence(credentialStore),
      });
      await ensureLocalService();
      void publishMaritimeSnapshot();
      maritimePublishTimer = setInterval(() => { void publishMaritimeSnapshot(); }, 5_000);
      createWindow();
    } catch (error) {
      dialog.showErrorBox("VoidCat Harness", error instanceof Error ? error.message : String(error));
      app.quit();
    }
  });

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    if (isQuitting) return;
    isQuitting = true;
    cleanupLocalResources();
  });
  app.on("activate", () => { if (!isQuitting && !mainWindow) createWindow(); });
}
