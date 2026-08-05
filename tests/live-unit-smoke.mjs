/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GIB = 1024 ** 3;
const HARD_MODEL_CEILING_BYTES = 7 * GIB;
const MINIMUM_MODEL_BYTES = 1 * GIB;
const MINIMUM_FREE_MEMORY_BYTES = 8 * GIB;
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceWorkspace = process.env.VOIDCAT_LIVE_UNIT_WORKSPACE
  ? path.resolve(process.env.VOIDCAT_LIVE_UNIT_WORKSPACE)
  : path.join(process.env.APPDATA ?? "", "voidcat-harness", "workspace");
const sourceCatalog = path.join(sourceWorkspace, ".voidcat", "model-library-catalog.json");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "voidcat-live-unit-"));
const isolatedCatalog = path.join(temporary, ".voidcat", "model-library-catalog.json");
const token = `voidcat-live-unit-${process.pid}`;
const lmsPath = path.join(os.homedir(), ".lmstudio", "bin", "lms.exe");
let server;
let port;
let loadAttempted = false;
let routeEjectionError;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") return reject(new Error("Port reservation failed."));
      probe.close(() => resolve(address.port));
    });
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, delay(5_000)]);
}

function runLms(args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(lmsPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-2_000_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`lms ${args[0]} failed (${code ?? "terminated"}): ${stderr.trim().slice(-1_000)}`));
    });
  });
}

async function api(pathname, init = {}, timeoutMs = 120_000) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: { "X-VoidCat-Desktop-Token": token, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try { message = JSON.parse(text).error ?? text; } catch { /* retain bounded response text */ }
    throw new Error(`${pathname} returned HTTP ${response.status}: ${String(message).slice(0, 1_000)}`);
  }
  return { response, text };
}

async function waitForHealth(stderr) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const { text } = await api("/api/health", {}, 2_000);
      const health = JSON.parse(text);
      if (health.app === "voidcat-harness" && health.desktopAuthenticated === true) return;
    } catch { /* preview may still be starting */ }
    await delay(150);
  }
  throw new Error(`Isolated VoidCat service did not become healthy. ${stderr()}`);
}

function streamSummary(stream) {
  let content = "";
  let reasoningCharacters = 0;
  let eventCount = 0;
  const finishReasons = [];
  for (const line of stream.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload);
      eventCount += 1;
      content += parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? "";
      reasoningCharacters += String(parsed.choices?.[0]?.delta?.reasoning_content ?? parsed.choices?.[0]?.delta?.reasoning ?? "").length;
      if (parsed.choices?.[0]?.finish_reason) finishReasons.push(parsed.choices[0].finish_reason);
    } catch { /* ignore provider comments and non-JSON event lines */ }
  }
  return { content: content.trim(), eventCount, reasoningCharacters, finishReasons };
}

async function verifiedEject() {
  if (!loadAttempted) return;
  try {
    await api("/api/runtime/unload", { method: "POST" }, 180_000);
  } catch (error) {
    routeEjectionError = error;
    await runLms(["unload", "voidcat-core"], 120_000).catch(() => undefined);
  }
  const output = await runLms(["ps", "--json"], 120_000);
  const loaded = JSON.parse(output || "[]");
  assert(!loaded.some((item) => item.identifier === "voidcat-core"), "The smoke test could not verify UNIT ejection.");
}

try {
  assert(process.env.VOIDCAT_LIVE_UNIT_TEST === "1", "Live UNIT testing is opt-in. Set VOIDCAT_LIVE_UNIT_TEST=1 explicitly.");
  assert(process.platform === "win32", "The live UNIT smoke test currently targets Windows.");
  assert(fs.existsSync(lmsPath), "LM Studio's lms.exe runtime was not found.");
  assert(fs.existsSync(sourceCatalog), `No saved UNIT catalog exists at ${sourceCatalog}.`);
  assert(os.freemem() >= MINIMUM_FREE_MEMORY_BYTES, `At least 8 GB of free memory is required; ${(os.freemem() / GIB).toFixed(1)} GB is available.`);
  const initiallyLoaded = JSON.parse(await runLms(["ps", "--json"], 120_000) || "[]");
  assert(Array.isArray(initiallyLoaded) && initiallyLoaded.length === 0, "Another LM Studio UNIT is already loaded; refusing to add memory pressure during a smoke test.");

  const requestedCeiling = Number(process.env.VOIDCAT_LIVE_UNIT_MAX_BYTES) || HARD_MODEL_CEILING_BYTES;
  const ceiling = Math.min(HARD_MODEL_CEILING_BYTES, requestedCeiling);
  const parsed = JSON.parse(fs.readFileSync(sourceCatalog, "utf8"));
  const candidates = (Array.isArray(parsed.models) ? parsed.models : [])
    .filter((model) => typeof model?.path === "string" && Number.isFinite(model?.sizeBytes))
    .filter((model) => model.sizeBytes >= MINIMUM_MODEL_BYTES && model.sizeBytes < ceiling)
    .filter((model) => !/(?:^|[-_.])mmproj(?:[-_.]|$)/i.test(path.basename(model.path)))
    .filter((model) => fs.existsSync(model.path))
    .sort((left, right) => left.sizeBytes - right.sizeBytes);
  assert(candidates.length > 0, `No real text UNIT below ${(ceiling / GIB).toFixed(1)} GB is available.`);

  fs.mkdirSync(path.dirname(isolatedCatalog), { recursive: true });
  fs.writeFileSync(isolatedCatalog, JSON.stringify({ version: 1, scannedAt: parsed.scannedAt, roots: parsed.roots ?? [], models: candidates }, null, 2));
  port = await reservePort();
  let serverError = "";
  server = spawn(process.execPath, [
    path.join(workspace, "node_modules", "vite", "bin", "vite.js"), "preview", workspace,
    "--config", path.join(workspace, "vite.desktop.config.ts"), "--host", "127.0.0.1", "--port", String(port), "--strictPort",
  ], {
    cwd: temporary,
    windowsHide: true,
    env: { ...process.env, VOIDCAT_DESKTOP_TOKEN: token },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => { serverError = `${serverError}${chunk}`.slice(-8_000); });
  await waitForHealth(() => serverError);

  const before = JSON.parse((await api("/api/runtime/status", {}, 5_000)).text);
  assert(!before.loaded?.some((item) => item.identifier === "voidcat-core"), "A VoidCat-owned UNIT appeared after the preflight check; refusing to replace it during a smoke test.");
  const catalog = JSON.parse((await api("/api/models", {}, 10_000)).text);
  const selected = catalog.models
    .filter((model) => model.sizeBytes >= MINIMUM_MODEL_BYTES && model.sizeBytes < ceiling && model.kind !== "embedding" && model.toolUse === true)
    .sort((left, right) => left.sizeBytes - right.sizeBytes)[0];
  assert(selected, "The isolated API did not publish a safe sub-7 GB tool-capable text UNIT.");
  process.stdout.write(`Loading ${selected.name} (${(selected.sizeBytes / GIB).toFixed(2)} GB) with a 2,048-token context...\n`);

  loadAttempted = true;
  const loaded = JSON.parse((await api("/api/runtime/load", { method: "POST", body: JSON.stringify({ modelKey: selected.modelKey, contextLength: 2_048 }) }, 12 * 60_000)).text);
  assert(loaded.loaded?.some((item) => item.identifier === "voidcat-core"), "The runtime load response did not identify voidcat-core.");

  const chat = await api("/api/chat", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "Reply with exactly VOIDCAT_UNIT_OK and no other text." }], temperature: 0, max_tokens: 512, contextLength: 2_048 }) }, 3 * 60_000);
  const chatSummary = streamSummary(chat.text);
  assert(chatSummary.content.length > 0, `The UNIT produced no visible assistant response (${JSON.stringify({ contentType: chat.response.headers.get("content-type"), ...chatSummary, content: undefined })}).`);
  assert(!/<think>|<analysis>|reasoning_content/i.test(chatSummary.content), "Private reasoning leaked into the visible assistant response.");

  const toolChat = await api("/api/chat", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "Search the OSINT directory for geolocation tools and cite the local records." }], temperature: 0, max_tokens: 512, contextLength: 2_048, enabledToolNames: ["voidcat.search-osint-directory"] }) }, 4 * 60_000);
  const toolSummary = streamSummary(toolChat.text);
  assert(/\[VC:[^\]]+\]/.test(toolSummary.content), `The bounded UNIT tool lane returned no local record citation (${JSON.stringify({ contentType: toolChat.response.headers.get("content-type"), ...toolSummary, content: undefined })}).`);
  process.stdout.write("Live UNIT chat and selected local-tool citation checks passed.\n");
} finally {
  try { await verifiedEject(); } finally {
    await stopServer(server);
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (routeEjectionError) throw new Error(`The normal UNIT eject route failed even though emergency cleanup succeeded: ${routeEjectionError.message}`);
process.stdout.write("Live UNIT smoke nominal: loaded below 7 GB, chatted, cited a selected local tool, and verified ejection.\n");
