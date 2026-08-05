/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require("electron");
const { spawn, execFile, execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const { SecureCredentialStore } = require("./secure-credential-store.cjs");
const { AisstreamMaritimeService } = require("./aisstream-maritime-service.cjs");
const { startOsintProviderBroker } = require("./osint-provider-broker.cjs");
const { ModelLibraryManager } = require("./model-library.cjs");
const { PublicWebcamService } = require("./public-webcam-service.cjs");
const { WindyWebcamService } = require("./windy-webcam-service.cjs");
const { ejectOwnedRuntime } = require("./runtime-ejection.cjs");

// VoidCat owns the only renderer origin; the renderer still decides whether sounds are enabled.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const APP_PORT = 4177;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const projectRoot = path.resolve(__dirname, "..");
const iconPath = path.join(projectRoot, "assets", "voidcat.ico");
const runtimeAssetRoot = app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked") : projectRoot;
const bundledWhisperExecutable = path.join(runtimeAssetRoot, "vendor", "whisper", "windows-x64", "Release", "whisper-cli.exe");
const bundledWhisperModel = path.join(runtimeAssetRoot, "vendor", "whisper", "windows-x64", "models", "ggml-tiny.en-q5_1.bin");
let workspaceRoot = projectRoot;
let runtimeDirectory = path.join(workspaceRoot, ".voidcat");
const lmsPath = path.join(process.env.USERPROFILE || "", ".lmstudio", "bin", "lms.exe");
const desktopToken = randomUUID();
let mainWindow = null;
let serverProcess = null;
let isQuitting = false;
let hasCleanedUp = false;
let cleanupPromise = null;
let credentialStore = null;
let maritimeService = null;
let maritimePublishTimer = null;
let maritimePublishActive = false;
let osintProviderBroker = null;
let voiceProcess = null;
let voiceGeneration = 0;
let transcriptionProcess = null;
let modelLibrary = null;
let publicWebcamService = null;
let windyWebcamService = null;

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
    const request = http.get(`${APP_URL}/api/health`, { timeout: 1_000, headers: { "X-VoidCat-Desktop-Token": desktopToken } }, (response) => {
      const chunks = [];
      let receivedBytes = 0;
      response.on("data", (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes <= 4096) chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const health = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(response.statusCode === 200 && health.app === "voidcat-harness" && health.desktopAuthenticated === true);
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

function runLms(args, timeout = 15_000) {
  return new Promise((resolve, reject) => execFile(lmsPath, args, { cwd: path.dirname(lmsPath), timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(String(stdout || ""))));
}

async function ejectVoidCatModel() {
  const ownershipMarker = path.join(runtimeDirectory, "runtime-owned.json");
  if (!fs.existsSync(lmsPath) || !fs.existsSync(ownershipMarker)) return { attempted: [], ejected: [], remaining: [], errors: [] };
  const result = await ejectOwnedRuntime({ markerPath: ownershipMarker, runUnload: (identifier) => runLms(["unload", identifier]), listLoaded: async () => { const parsed = JSON.parse(await runLms(["ps", "--json"], 10_000) || "[]"); return (Array.isArray(parsed) ? parsed : []).map((item) => String(item?.identifier ?? "")).filter(Boolean); } });
  if (result.remaining.length) writeRendererDiagnostic("runtime-ejection-pending", `Unable to verify ejection for ${result.remaining.join(", ")}; ownership marker retained for retry.`);
  return result;
}

function cleanupLocalResources() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
  if (maritimePublishTimer) clearInterval(maritimePublishTimer);
  maritimePublishTimer = null;
  maritimeService?.stop();
  if (osintProviderBroker) await osintProviderBroker.close().catch(() => undefined);
  osintProviderBroker = null;
  if (voiceProcess && voiceProcess.exitCode === null) voiceProcess.kill();
  if (transcriptionProcess && transcriptionProcess.exitCode === null) transcriptionProcess.kill();
  voiceProcess = null; transcriptionProcess = null;
  modelLibrary?.cancel();
  await ejectVoidCatModel();
  if (serverProcess && serverProcess.exitCode === null) serverProcess.kill();
  })();
  return cleanupPromise;
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

  const rendererSession = mainWindow.webContents.session;
  const appOrigin = new URL(APP_URL).origin;
  const trustedVoiceOrigin = (webContents, details) => {
    if (!webContents || webContents !== mainWindow?.webContents) return false;
    const origin = details?.securityOrigin || details?.requestingUrl || webContents.getURL();
    try { return new URL(origin).origin === appOrigin; } catch { return false; }
  };
  rendererSession.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) => permission === "media" && details?.mediaType === "audio" && trustedVoiceOrigin(webContents, details));
  rendererSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
    const requestsAudioOnly = mediaTypes.length === 0 || (mediaTypes.includes("audio") && !mediaTypes.includes("video"));
    callback(permission === "media" && requestsAudioOnly && trustedVoiceOrigin(webContents, details));
  });

  mainWindow.removeMenu();
  mainWindow.loadURL(APP_URL);
  mainWindow.once("ready-to-show", () => {
    mainWindow?.maximize();
    mainWindow?.show();
  });
  // Popups are always denied. External destinations can only pass through the
  // validated, confirmed IPC handler below after a real renderer link click.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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
  mainWindow.on("closed", () => { mainWindow = null; });
}

ipcMain.handle("voidcat:choose-rag-folder", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Register a RAG folder",
    properties: ["openDirectory"],
  });
  return result.canceled ? null : result.filePaths[0] || null;
});

function validatedExternalUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) throw new Error("The external link is invalid.");
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("VoidCat opens only encrypted HTTPS destinations; legacy HTTP links remain visible but blocked.");
  if (!url.hostname || url.username || url.password) throw new Error("VoidCat blocks malformed or credential-bearing links.");
  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase())) throw new Error("VoidCat will not hand local service links to Windows.");
  return url;
}

function isTrustedRendererInvocation(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  try { return new URL(event.senderFrame?.url || event.sender.getURL()).origin === new URL(APP_URL).origin; }
  catch { return false; }
}

ipcMain.handle("voidcat:external:open", async (event, rawUrl) => {
  if (!isTrustedRendererInvocation(event)) throw new Error("External links are restricted to the VoidCat interface.");
  const url = validatedExternalUrl(rawUrl);
  const normalized = url.toString();
  const choice = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "VoidCat External Link",
    message: "Open this external website?",
    detail: `${url.hostname}\n\nWindows may hand web links to another installed application. Nothing opens unless you choose OPEN IN BROWSER.`,
    buttons: ["CANCEL", "OPEN IN BROWSER"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (choice.response !== 1) return { opened: false, cancelled: true, url: normalized };
  await shell.openExternal(normalized, { activate: true });
  return { opened: true, cancelled: false, url: normalized };
});

ipcMain.handle("voidcat:docs:open-how-to-use", async () => {
  const documentPath = path.join(projectRoot, "public", "HOW_TO_USE_VOIDCAT.txt");
  if (!fs.existsSync(documentPath)) throw new Error("The VoidCat operator guide is missing from this installation.");
  const openError = await shell.openPath(documentPath);
  if (openError) throw new Error(openError);
  return { opened: true, path: documentPath };
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
  const customExecutable = store.get("voidcat.voice", "whisper-executable") || "";
  const customModel = store.get("voidcat.voice", "whisper-model") || "";
  const executablePath = customExecutable && fs.existsSync(customExecutable) ? customExecutable : bundledWhisperExecutable;
  const modelPath = customModel && fs.existsSync(customModel) ? customModel : bundledWhisperModel;
  return { executablePath, modelPath, bundled: executablePath === bundledWhisperExecutable || modelPath === bundledWhisperModel };
}
function sanitizeVoiceDeviceValue(value, maximumLength) {
  return Array.from(String(value ?? "")).filter((character) => { const code = character.charCodeAt(0); return code >= 32 && code !== 127; }).join("").slice(0, maximumLength);
}
function listWindowsSpeechOutputs() {
  if (process.platform !== "win32") return { outputDevices: [], outputDeviceError: "Windows speech outputs are unavailable on this platform." };
  const script = "$s=New-Object -ComObject SAPI.SpVoice; @($s.GetAudioOutputs()) | ForEach-Object { [PSCustomObject]@{ id=$_.Id; label=$_.GetDescription() } } | ConvertTo-Json -Compress";
  try {
    const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 8_000, maxBuffer: 64 * 1024 }).trim();
    const parsed = raw ? JSON.parse(raw) : []; const records = Array.isArray(parsed) ? parsed : [parsed];
    const outputDevices = records.filter((record) => record && typeof record.id === "string" && typeof record.label === "string").slice(0, 64).map((record) => ({ id: sanitizeVoiceDeviceValue(record.id, 512), label: sanitizeVoiceDeviceValue(record.label, 160) })).filter((record) => record.id && record.label);
    return { outputDevices, outputDeviceError: null };
  } catch (error) {
    writeRendererDiagnostic("voice-output-enumeration", error instanceof Error ? error.message : String(error));
    return { outputDevices: [], outputDeviceError: "Windows did not return a selectable speech output. System default remains available." };
  }
}
function voiceStatus(includeOutputDevices = false) {
  const config = voiceConfig();
  const outputs = includeOutputDevices ? listWindowsSpeechOutputs() : { outputDevices: [], outputDeviceError: null };
  return { local: true, bundled: config.bundled, ttsAvailable: process.platform === "win32", transcriptionAvailable: Boolean(config.executablePath && config.modelPath && fs.existsSync(config.executablePath) && fs.existsSync(config.modelPath)), executableConfigured: Boolean(config.executablePath && fs.existsSync(config.executablePath)), modelConfigured: Boolean(config.modelPath && fs.existsSync(config.modelPath)), executableName: config.executablePath && fs.existsSync(config.executablePath) ? path.basename(config.executablePath) : null, modelName: config.modelPath && fs.existsSync(config.modelPath) ? path.basename(config.modelPath) : null, ...outputs };
}
ipcMain.handle("voidcat:voice:status", () => voiceStatus(true));
ipcMain.handle("voidcat:voice:choose-executable", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: "Select whisper.cpp executable", properties: ["openFile"], filters: [{ name: "whisper.cpp", extensions: ["exe"] }] });
  if (result.canceled || !result.filePaths[0]) return voiceStatus(true); requireCredentialStore().set("voidcat.voice", "whisper-executable", result.filePaths[0]); return voiceStatus(true);
});
ipcMain.handle("voidcat:voice:choose-model", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: "Select local Whisper model", properties: ["openFile"], filters: [{ name: "Whisper models", extensions: ["bin"] }] });
  if (result.canceled || !result.filePaths[0]) return voiceStatus(true); requireCredentialStore().set("voidcat.voice", "whisper-model", result.filePaths[0]); return voiceStatus(true);
});
ipcMain.handle("voidcat:voice:stop", () => { voiceGeneration += 1; if (voiceProcess && voiceProcess.exitCode === null) voiceProcess.kill(); voiceProcess = null; return { stopped: true }; });
ipcMain.handle("voidcat:voice:speak", async (_event, input) => {
  if (process.platform !== "win32") throw new Error("Local Windows speech synthesis is unavailable on this platform.");
  const generation = ++voiceGeneration; if (voiceProcess && voiceProcess.exitCode === null) voiceProcess.kill();
  const text = String(input?.text ?? "").trim().slice(0, 12_000); if (!text) return { spoken: false };
  const profile = ["computer-male", "computer-female", "tactical-commander", "high-energy-pilot"].includes(input?.profile) ? input.profile : "computer-female";
  const speed = Math.max(0.5, Math.min(2, Number(input?.speed) || 1));
  const voiceProfiles = {
    "computer-male": { gender: "Male", voiceIndex: 0, rateOffset: -1, pitch: -4, volume: 88 },
    "computer-female": { gender: "Female", voiceIndex: 0, rateOffset: 0, pitch: 2, volume: 94 },
    "tactical-commander": { gender: "Male", voiceIndex: 1, rateOffset: -3, pitch: -8, volume: 100 },
    "high-energy-pilot": { gender: "Female", voiceIndex: 1, rateOffset: 4, pitch: 7, volume: 96 },
  };
  const selectedProfile = voiceProfiles[profile];
  const script = "$s=New-Object -ComObject SAPI.SpVoice; $voices=@($s.GetVoices()); $wanted=$env:VOIDCAT_SPEECH_GENDER; $matching=@($voices|Where-Object{$_.GetAttribute('Gender') -eq $wanted}); if(-not $matching.Count){$matching=$voices}; $index=[Math]::Max(0,[int]$env:VOIDCAT_SPEECH_VOICE_INDEX); if($matching.Count){$s.Voice=$matching[$index % $matching.Count]}; $wantedOutput=$env:VOIDCAT_SPEECH_OUTPUT; if($wantedOutput){$output=@($s.GetAudioOutputs())|Where-Object{$_.Id -eq $wantedOutput}|Select-Object -First 1; if($output){$s.AudioOutput=$output}}; $s.Rate=[Math]::Max(-10,[Math]::Min(10,[int]$env:VOIDCAT_SPEECH_RATE)); $s.Volume=[Math]::Max(0,[Math]::Min(100,[int]$env:VOIDCAT_SPEECH_VOLUME)); $safe=[Security.SecurityElement]::Escape($env:VOIDCAT_SPEECH_TEXT); $pitch=[Math]::Max(-10,[Math]::Min(10,[int]$env:VOIDCAT_SPEECH_PITCH)); $xml=\"<sapi><pitch middle='$pitch'>$safe</pitch></sapi>\"; $null=$s.Speak($xml,8)";
  const rate = Math.round((speed - 1) * 8) + selectedProfile.rateOffset;
  const outputDeviceId = sanitizeVoiceDeviceValue(input?.outputDeviceId, 512);
  const sentences = (text.match(/[^.!?\n]+(?:[.!?]+|\n+|$)/g) || [text]).flatMap((sentence) => sentence.trim().match(/[\s\S]{1,600}/g) || []).slice(0, 80);
  let spokenSentences = 0;
  for (const sentence of sentences) {
    if (generation !== voiceGeneration) break;
    await new Promise((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, env: { ...process.env, VOIDCAT_SPEECH_TEXT: sentence, VOIDCAT_SPEECH_GENDER: selectedProfile.gender, VOIDCAT_SPEECH_VOICE_INDEX: String(selectedProfile.voiceIndex), VOIDCAT_SPEECH_RATE: String(rate), VOIDCAT_SPEECH_PITCH: String(selectedProfile.pitch), VOIDCAT_SPEECH_VOLUME: String(selectedProfile.volume), VOIDCAT_SPEECH_OUTPUT: outputDeviceId }, stdio: "ignore" });
      voiceProcess = child;
      child.once("error", reject); child.once("exit", (code, signal) => { if (voiceProcess === child) voiceProcess = null; if (code === 0 || signal || generation !== voiceGeneration) resolve(); else reject(new Error("Local speech synthesis stopped unexpectedly.")); });
    });
    if (generation === voiceGeneration) spokenSentences += 1;
  }
  return { spoken: spokenSentences > 0, spokenSentences, interrupted: generation !== voiceGeneration };
});
ipcMain.handle("voidcat:voice:transcribe", async (_event, audioBytes) => {
  const config = voiceConfig(); if (!voiceStatus().transcriptionAvailable) throw new Error("The bundled local Whisper runtime is missing. Reinstall VoidCat Harness or select an advanced override in App Settings.");
  const bytes = Buffer.from(audioBytes); if (bytes.length < 44 || bytes.length > 25 * 1024 ** 2 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WAVE") throw new Error("Microphone capture was not a bounded WAV recording.");
  if (transcriptionProcess && transcriptionProcess.exitCode === null) throw new Error("A local transcription is already running.");
  const directory = path.join(runtimeDirectory, "voice", "tmp"); fs.mkdirSync(directory, { recursive: true }); const id = randomUUID(); const wavPath = path.join(directory, `${id}.wav`); const outputBase = path.join(directory, id); fs.writeFileSync(wavPath, bytes);
  try {
    await new Promise((resolve, reject) => {
      const threadCount = Math.max(1, Math.min(4, typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length));
      const child = spawn(config.executablePath, ["-m", config.modelPath, "-f", wavPath, "-otxt", "-of", outputBase, "-nt", "-np", "-sns", "-l", "en", "-t", String(threadCount)], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      transcriptionProcess = child; let errorText = ""; let timedOut = false; let settled = false;
      const timeout = setTimeout(() => { timedOut = true; if (child.exitCode === null) child.kill(); }, 180_000);
      const finish = (error) => { if (settled) return; settled = true; clearTimeout(timeout); if (transcriptionProcess === child) transcriptionProcess = null; if (error) reject(error); else resolve(); };
      child.stderr.on("data", (chunk) => { if (errorText.length < 4_000) errorText += chunk.toString("utf8"); });
      child.once("error", (error) => finish(new Error(`The local Whisper engine could not start: ${error.message}`)));
      child.once("close", (code) => { if (timedOut) finish(new Error("Local transcription exceeded its three-minute safety limit.")); else if (code === 0) finish(); else finish(new Error(errorText.trim().slice(-500) || `whisper.cpp exited with code ${code}.`)); });
    });
    const transcriptPath = `${outputBase}.txt`; if (!fs.existsSync(transcriptPath)) throw new Error("Whisper completed without producing a transcript file.");
    const text = fs.readFileSync(transcriptPath, "utf8").replace(/\[(?:blank_audio|silence|music|noise)\]/gi, " ").replace(/\s+/g, " ").trim().slice(0, 8_000);
    return { text, local: true, engine: "whisper.cpp" };
  } finally { transcriptionProcess = null; for (const file of [wavPath, `${outputBase}.txt`]) { try { fs.rmSync(file, { force: true }); } catch { /* temporary voice files may already be absent */ } } }
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
ipcMain.handle("voidcat:webcams:status", () => {
  if (!publicWebcamService) throw new Error("The protected public-webcam service is unavailable.");
  return publicWebcamService.status();
});
ipcMain.handle("voidcat:webcams:configure", (_event, credential) => {
  if (!publicWebcamService) throw new Error("The protected public-webcam service is unavailable.");
  return publicWebcamService.configure(credential);
});
ipcMain.handle("voidcat:webcams:remove", () => {
  if (!publicWebcamService) throw new Error("The protected public-webcam service is unavailable.");
  return publicWebcamService.remove();
});
ipcMain.handle("voidcat:webcams:load-region", (_event, regionId) => {
  if (!publicWebcamService) throw new Error("The protected public-webcam service is unavailable.");
  return publicWebcamService.loadRegion(regionId);
});
ipcMain.handle("voidcat:windy-webcams:status", () => {
  if (!windyWebcamService) throw new Error("The protected Windy webcam service is unavailable.");
  return windyWebcamService.status();
});
ipcMain.handle("voidcat:windy-webcams:configure", (_event, credential) => {
  if (!windyWebcamService) throw new Error("The protected Windy webcam service is unavailable.");
  return windyWebcamService.configure(credential);
});
ipcMain.handle("voidcat:windy-webcams:remove", () => {
  if (!windyWebcamService) throw new Error("The protected Windy webcam service is unavailable.");
  return windyWebcamService.remove();
});
ipcMain.handle("voidcat:windy-webcams:load-region", (_event, regionId) => {
  if (!windyWebcamService) throw new Error("The protected Windy webcam service is unavailable.");
  return windyWebcamService.loadRegion(regionId);
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
      const registeredModelRefresh = modelLibrary.refreshRegisteredFolders().catch((error) => {
        writeRendererDiagnostic("registered-model-refresh", error instanceof Error ? error.message : String(error));
        return null;
      });
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
      publicWebcamService = new PublicWebcamService({ credentialStore });
      windyWebcamService = new WindyWebcamService({ credentialStore });
      if (savedMaritimeEnabled(credentialStore) && credentialStore.get("vc-hunter-seeker.aisstream", "websocket-token")) {
        await maritimeService.start(savedMaritimeCoverage(credentialStore));
      }
      await ensureLocalService();
      void registeredModelRefresh;
      void publishMaritimeSnapshot();
      maritimePublishTimer = setInterval(() => { void publishMaritimeSnapshot(); }, 5_000);
      createWindow();
    } catch (error) {
      dialog.showErrorBox("VoidCat Harness", error instanceof Error ? error.message : String(error));
      app.quit();
    }
  });

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (hasCleanedUp) return;
    event.preventDefault(); isQuitting = true;
    void cleanupLocalResources().finally(() => { hasCleanedUp = true; app.quit(); });
  });
  app.on("activate", () => { if (!isQuitting && !mainWindow) createWindow(); });
}
