const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require("electron");
const { spawn, execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const { SecureCredentialStore } = require("./secure-credential-store.cjs");
const { AisstreamMaritimeService } = require("./aisstream-maritime-service.cjs");
const { startOsintProviderBroker } = require("./osint-provider-broker.cjs");
const { ModelLibraryManager } = require("./model-library.cjs");

const APP_PORT = 4177;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const projectRoot = path.resolve(__dirname, "..");
const iconPath = path.join(projectRoot, "assets", "voidcat.ico");
let workspaceRoot = projectRoot;
let runtimeDirectory = path.join(workspaceRoot, ".voidcat");
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
let osintProviderBroker = null;
let voiceProcess = null;
let voiceGeneration = 0;
let transcriptionProcess = null;
let modelLibrary = null;

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
  if (osintProviderBroker) void osintProviderBroker.close();
  osintProviderBroker = null;
  if (voiceProcess && voiceProcess.exitCode === null) voiceProcess.kill();
  if (transcriptionProcess && transcriptionProcess.exitCode === null) transcriptionProcess.kill();
  voiceProcess = null; transcriptionProcess = null;
  modelLibrary?.cancel();
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
  const lanEnabled = credentialStore?.get("voidcat.lan", "enabled") === "true";
  let lanToken = credentialStore?.get("voidcat.lan", "token") || "";
  if (lanEnabled && !lanToken) { lanToken = randomUUID() + randomUUID(); credentialStore.set("voidcat.lan", "token", lanToken); }
  const nodeExecutable = app.isPackaged ? process.execPath : findNode();
  const viteExecutable = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
  const viteArguments = app.isPackaged
    ? ["--use-system-ca", viteExecutable, "preview", projectRoot, "--config", path.join(projectRoot, "vite.desktop.config.ts"), "--host", lanEnabled ? "0.0.0.0" : "127.0.0.1", "--port", String(APP_PORT), "--strictPort"]
    : ["--use-system-ca", viteExecutable, projectRoot, "--config", path.join(projectRoot, "vite.config.ts"), "--host", lanEnabled ? "0.0.0.0" : "127.0.0.1", "--port", String(APP_PORT), "--strictPort"];
  serverProcess = spawn(nodeExecutable, viteArguments, {
    cwd: workspaceRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: app.isPackaged ? "1" : process.env.ELECTRON_RUN_AS_NODE, VOIDCAT_DESKTOP_TOKEN: desktopToken, VOIDCAT_OSINT_BROKER_PORT: osintProviderBroker ? String(osintProviderBroker.port) : "", VOIDCAT_LAN_TOKEN: lanEnabled ? lanToken : "" },
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

function requireModelLibrary() {
  if (!modelLibrary) throw new Error("The local model library is not initialized.");
  return modelLibrary;
}

ipcMain.handle("voidcat:models:status", () => requireModelLibrary().status());
ipcMain.handle("voidcat:models:choose-primary-folder", async () => {
  if (!mainWindow) return requireModelLibrary().status();
  const current = requireModelLibrary().readSettings().primaryFolder;
  const result = await dialog.showOpenDialog(mainWindow, { title: "Choose VoidCat model storage folder", defaultPath: current, properties: ["openDirectory", "createDirectory"] });
  return result.canceled || !result.filePaths[0] ? requireModelLibrary().status() : requireModelLibrary().setPrimaryFolder(result.filePaths[0]);
});
ipcMain.handle("voidcat:models:choose-scan-folder", async () => {
  if (!mainWindow) return requireModelLibrary().status();
  const result = await dialog.showOpenDialog(mainWindow, { title: "Choose a targeted model scan folder", properties: ["openDirectory"] });
  return result.canceled || !result.filePaths[0] ? requireModelLibrary().status() : requireModelLibrary().addScanFolder(result.filePaths[0]);
});
ipcMain.handle("voidcat:models:remove-scan-folder", (_event, folder) => requireModelLibrary().removeScanFolder(String(folder ?? "")));
ipcMain.handle("voidcat:models:scan", (_event, input) => requireModelLibrary().scan({ mode: input?.mode, root: input?.root }));
ipcMain.handle("voidcat:models:cancel-scan", () => ({ cancelled: requireModelLibrary().cancel() }));

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

function savedMaritimeEnabled(store = requireCredentialStore()) {
  return store.get("vc-hunter-seeker.aisstream", "enabled") === "true";
}

ipcMain.handle("voidcat:credentials:set", (_event, namespace, key, value) => requireCredentialStore().set(namespace, key, value));
ipcMain.handle("voidcat:credentials:delete", (_event, namespace, key) => requireCredentialStore().delete(namespace, key));
ipcMain.handle("voidcat:credentials:list", (_event, namespace) => requireCredentialStore().list(namespace));
ipcMain.handle("voidcat:credentials:describe", (_event, namespace, key) => requireCredentialStore().describe(namespace, key));
ipcMain.handle("voidcat:credentials:test", () => requireCredentialStore().test());
function lanStatus() {
  const store = requireCredentialStore(); const enabled = store.get("voidcat.lan", "enabled") === "true"; const token = store.get("voidcat.lan", "token") || ""; const addresses = [];
  for (const records of Object.values(os.networkInterfaces())) for (const record of records || []) if (record.family === "IPv4" && !record.internal) addresses.push(`http://${record.address}:${APP_PORT}/?voidcat_token=${encodeURIComponent(token)}`);
  return { enabled, authentication: "required", token: enabled ? token : null, urls: enabled ? addresses : [], restartRequired: false };
}
ipcMain.handle("voidcat:lan:status", () => lanStatus());
ipcMain.handle("voidcat:lan:configure", (_event, enabled) => { const store = requireCredentialStore(); store.set("voidcat.lan", "enabled", enabled === true ? "true" : "false"); if (enabled === true && !store.get("voidcat.lan", "token")) store.set("voidcat.lan", "token", randomUUID() + randomUUID()); return { ...lanStatus(), restartRequired: true }; });
function voiceConfig() {
  const store = requireCredentialStore();
  return { executablePath: store.get("voidcat.voice", "whisper-executable") || "", modelPath: store.get("voidcat.voice", "whisper-model") || "" };
}
function voiceStatus() {
  const config = voiceConfig();
  return { local: true, ttsAvailable: process.platform === "win32", transcriptionAvailable: Boolean(config.executablePath && config.modelPath && fs.existsSync(config.executablePath) && fs.existsSync(config.modelPath)), executableConfigured: Boolean(config.executablePath), modelConfigured: Boolean(config.modelPath), executableName: config.executablePath ? path.basename(config.executablePath) : null, modelName: config.modelPath ? path.basename(config.modelPath) : null };
}
ipcMain.handle("voidcat:voice:status", () => voiceStatus());
ipcMain.handle("voidcat:voice:choose-executable", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: "Select whisper.cpp executable", properties: ["openFile"], filters: [{ name: "whisper.cpp", extensions: ["exe"] }] });
  if (result.canceled || !result.filePaths[0]) return voiceStatus(); requireCredentialStore().set("voidcat.voice", "whisper-executable", result.filePaths[0]); return voiceStatus();
});
ipcMain.handle("voidcat:voice:choose-model", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: "Select local Whisper model", properties: ["openFile"], filters: [{ name: "Whisper models", extensions: ["bin"] }] });
  if (result.canceled || !result.filePaths[0]) return voiceStatus(); requireCredentialStore().set("voidcat.voice", "whisper-model", result.filePaths[0]); return voiceStatus();
});
ipcMain.handle("voidcat:voice:stop", () => { voiceGeneration += 1; if (voiceProcess && voiceProcess.exitCode === null) voiceProcess.kill(); voiceProcess = null; return { stopped: true }; });
ipcMain.handle("voidcat:voice:speak", async (_event, input) => {
  if (process.platform !== "win32") throw new Error("Local Windows speech synthesis is unavailable on this platform.");
  const generation = ++voiceGeneration; if (voiceProcess && voiceProcess.exitCode === null) voiceProcess.kill();
  const text = String(input?.text ?? "").trim().slice(0, 12_000); if (!text) return { spoken: false };
  const profile = ["computer-male", "computer-female", "tactical-commander", "high-energy-pilot"].includes(input?.profile) ? input.profile : "computer-female";
  const speed = Math.max(0.5, Math.min(2, Number(input?.speed) || 1));
  const gender = profile === "computer-male" ? "Male" : "Female"; const rateOffset = profile === "tactical-commander" ? -1 : profile === "high-energy-pilot" ? 2 : 0;
  const script = "Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $g=[System.Speech.Synthesis.VoiceGender]::$env:VOIDCAT_SPEECH_GENDER; try{$s.SelectVoiceByHints($g)}catch{}; $s.Rate=[Math]::Max(-10,[Math]::Min(10,[int]$env:VOIDCAT_SPEECH_RATE)); $s.Volume=100; $s.Speak($env:VOIDCAT_SPEECH_TEXT)";
  const rate = Math.round((speed - 1) * 8) + rateOffset;
  const sentences = (text.match(/[^.!?\n]+(?:[.!?]+|\n+|$)/g) || [text]).flatMap((sentence) => sentence.trim().match(/[\s\S]{1,600}/g) || []).slice(0, 80);
  let spokenSentences = 0;
  for (const sentence of sentences) {
    if (generation !== voiceGeneration) break;
    await new Promise((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, env: { ...process.env, VOIDCAT_SPEECH_TEXT: sentence, VOIDCAT_SPEECH_GENDER: gender, VOIDCAT_SPEECH_RATE: String(rate) }, stdio: "ignore" });
      voiceProcess = child;
      child.once("error", reject); child.once("exit", (code, signal) => { if (voiceProcess === child) voiceProcess = null; if (code === 0 || signal || generation !== voiceGeneration) resolve(); else reject(new Error("Local speech synthesis stopped unexpectedly.")); });
    });
    if (generation === voiceGeneration) spokenSentences += 1;
  }
  return { spoken: spokenSentences > 0, spokenSentences, interrupted: generation !== voiceGeneration };
});
ipcMain.handle("voidcat:voice:transcribe", async (_event, audioBytes) => {
  const config = voiceConfig(); if (!voiceStatus().transcriptionAvailable) throw new Error("Choose a whisper.cpp executable and local model in App Settings first.");
  const bytes = Buffer.from(audioBytes); if (bytes.length < 44 || bytes.length > 25 * 1024 ** 2 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WAVE") throw new Error("Microphone capture was not a bounded WAV recording.");
  if (transcriptionProcess && transcriptionProcess.exitCode === null) throw new Error("A local transcription is already running.");
  const directory = path.join(runtimeDirectory, "voice", "tmp"); fs.mkdirSync(directory, { recursive: true }); const id = randomUUID(); const wavPath = path.join(directory, `${id}.wav`); const outputBase = path.join(directory, id); fs.writeFileSync(wavPath, bytes);
  try {
    await new Promise((resolve, reject) => {
      transcriptionProcess = spawn(config.executablePath, ["-m", config.modelPath, "-f", wavPath, "-otxt", "-of", outputBase, "-nt"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }); let errorText = "";
      transcriptionProcess.stderr.on("data", (chunk) => { if (errorText.length < 4_000) errorText += chunk.toString("utf8"); }); transcriptionProcess.once("error", reject); transcriptionProcess.once("exit", (code) => { transcriptionProcess = null; if (code === 0) resolve(); else reject(new Error(errorText.trim().slice(-500) || `whisper.cpp exited with code ${code}.`)); });
    });
    const text = fs.readFileSync(`${outputBase}.txt`, "utf8").trim().slice(0, 8_000); return { text, local: true, engine: "whisper.cpp" };
  } finally { for (const file of [wavPath, `${outputBase}.txt`]) { try { fs.rmSync(file, { force: true }); } catch { /* temporary voice files may already be absent */ } } }
});
ipcMain.handle("voidcat:osint:status", () => {
  if (!osintProviderBroker) throw new Error("The protected OSINT provider broker is unavailable.");
  return { providers: osintProviderBroker.service.status() };
});
ipcMain.handle("voidcat:osint:configure", (_event, providerId, values) => {
  if (!osintProviderBroker) throw new Error("The protected OSINT provider broker is unavailable.");
  return osintProviderBroker.service.configure(providerId, values);
});
ipcMain.handle("voidcat:osint:remove", (_event, providerId) => {
  if (!osintProviderBroker) throw new Error("The protected OSINT provider broker is unavailable.");
  return osintProviderBroker.service.remove(providerId);
});
ipcMain.handle("voidcat:osint:test", (_event, providerId) => {
  if (!osintProviderBroker) throw new Error("The protected OSINT provider broker is unavailable.");
  return osintProviderBroker.service.test(providerId);
});
ipcMain.handle("voidcat:maritime:start", async (_event, regionIds) => {
  if (!maritimeService) throw new Error("Maritime service is not initialized.");
  const selectedRegions = Array.isArray(regionIds) && regionIds.length
    ? regionIds
    : savedMaritimeCoverage();
  const snapshot = await maritimeService.start(selectedRegions);
  requireCredentialStore().set("vc-hunter-seeker.aisstream", "coverage-regions", JSON.stringify(snapshot.regionIds));
  requireCredentialStore().set("vc-hunter-seeker.aisstream", "enabled", "true");
  void publishMaritimeSnapshot();
  return snapshot;
});
ipcMain.handle("voidcat:maritime:stop", () => { const snapshot = maritimeService?.stop(); void publishMaritimeSnapshot(); return snapshot; });
ipcMain.handle("voidcat:maritime:disable", () => { requireCredentialStore().set("vc-hunter-seeker.aisstream", "enabled", "false"); const snapshot = maritimeService?.disable(); void publishMaritimeSnapshot(); return snapshot; });
ipcMain.handle("voidcat:maritime:snapshot", () => maritimeService?.snapshot());
ipcMain.handle("voidcat:maritime:test-credential", (_event, credential, regionIds) => {
  if (!maritimeService) throw new Error("Maritime service is not initialized.");
  return maritimeService.testCredential(credential, regionIds);
});
ipcMain.handle("voidcat:maritime:test-saved-credential", (_event, regionIds) => {
  if (!maritimeService) throw new Error("Maritime service is not initialized.");
  const credential = requireCredentialStore().get("vc-hunter-seeker.aisstream", "websocket-token");
  if (!credential) throw new Error("No saved aisstream.io credential is available to test.");
  return maritimeService.testCredential(credential, regionIds);
});
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
      if (app.isPackaged) {
        workspaceRoot = path.join(app.getPath("userData"), "workspace");
        runtimeDirectory = path.join(workspaceRoot, ".voidcat");
      }
      fs.mkdirSync(runtimeDirectory, { recursive: true });
      modelLibrary = new ModelLibraryManager({ runtimeDirectory, homeDirectory: os.homedir() });
      credentialStore = new SecureCredentialStore({
        safeStorage,
        filePath: path.join(runtimeDirectory, "secure-credentials.json"),
      });
      credentialStore.test();
      osintProviderBroker = await startOsintProviderBroker({ credentialStore, token: desktopToken });
      maritimeService = new AisstreamMaritimeService({
        getCredential: () => credentialStore.get("vc-hunter-seeker.aisstream", "websocket-token"),
        defaultRegionIds: savedMaritimeCoverage(credentialStore),
        defaultDisplayCadenceMs: savedMaritimeDisplayCadence(credentialStore),
      });
      if (savedMaritimeEnabled(credentialStore) && credentialStore.get("vc-hunter-seeker.aisstream", "websocket-token")) {
        await maritimeService.start(savedMaritimeCoverage(credentialStore));
      }
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
