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

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(workspace, "release", "VoidCat Harness-win32-x64");
const executable = path.join(packageRoot, "VoidCat Harness.exe");
const archive = path.join(packageRoot, "resources", "app.asar");
const serverRoot = path.join(packageRoot, "resources", "app.asar.unpacked");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "voidcat-packaged-runtime-smoke-"));
const token = "voidcat-packaged-runtime-smoke-token";
let server;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, delay(5_000)]);
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

function request(port, pathname, headers = {}, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const operation = http.get({ hostname: "127.0.0.1", port, path: pathname, headers, timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    operation.on("timeout", () => operation.destroy(new Error("Request timed out.")));
    operation.on("error", reject);
  });
}

async function waitForHealth(port, diagnostics) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, "/api/health", { "X-VoidCat-Desktop-Token": token });
      if (response.status === 200) return response;
    } catch {
      // The packaged server may still be loading from ASAR.
    }
    if (server?.exitCode !== null) break;
    await delay(100);
  }
  throw new Error(`Packaged runtime did not become healthy. ${diagnostics()}`);
}

try {
  for (const required of [executable, archive, path.join(serverRoot, "vite.desktop.config.ts")]) {
    if (!fs.existsSync(required)) throw new Error(`Build the Windows package first; missing ${required}`);
  }
  const port = await reservePort();
  let output = "";
  server = spawn(executable, [
    "--use-system-ca",
    path.join(serverRoot, "node_modules", "vite", "bin", "vite.js"),
    "preview",
    serverRoot,
    "--config",
    path.join(serverRoot, "vite.desktop.config.ts"),
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ], {
    cwd: temporary,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      VOIDCAT_DESKTOP_TOKEN: token,
      VOIDCAT_OFFLINE_TEST: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk) => { output = `${output}${chunk}`.slice(-8_000); };
  server.stdout.on("data", capture);
  server.stderr.on("data", capture);

  const health = await waitForHealth(port, () => output);
  const body = JSON.parse(health.body);
  if (body.app !== "voidcat-harness" || body.desktopAuthenticated !== true || Object.hasOwn(body, "token")) {
    throw new Error("Packaged health response violated the desktop contract.");
  }
  const index = await request(port, "/", {}, 5_000);
  if (index.status !== 200 || !/Content-Security-Policy/i.test(index.body) || !/frame-ancestors 'none'/i.test(String(index.headers["content-security-policy"] ?? "")) || !/type="module"/i.test(index.body)) {
    throw new Error("Packaged renderer entry point is missing or malformed.");
  }
  process.stdout.write("Packaged runtime smoke nominal: ASAR backend, authenticated health, CSP, and renderer entry point.\n");
} finally {
  await stopServer(server);
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
