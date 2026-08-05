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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "voidcat-server-smoke-"));
const token = "voidcat-server-smoke-token";
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

function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const operation = http.get({ hostname: "127.0.0.1", port, path: pathname, headers, timeout: 1_000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    operation.on("timeout", () => operation.destroy(new Error("Request timed out.")));
    operation.on("error", reject);
  });
}

async function waitForHealth(port, stderr) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, "/api/health", { "X-VoidCat-Desktop-Token": token });
      if (response.status === 200) return response;
    } catch {
      // The disposable server may still be starting; retry until the deadline.
    }
    await delay(100);
  }
  throw new Error(`Disposable preview did not become healthy. ${stderr()}`);
}

try {
  const port = await reservePort();
  let serverError = "";
  server = spawn(process.execPath, [
    path.join(workspace, "node_modules", "vite", "bin", "vite.js"),
    "preview",
    workspace,
    "--config",
    path.join(workspace, "vite.desktop.config.ts"),
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ], {
    cwd: temporary,
    windowsHide: true,
    env: { ...process.env, VOIDCAT_DESKTOP_TOKEN: token, VOIDCAT_OFFLINE_TEST: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => { serverError = `${serverError}${chunk}`.slice(-4_000); });

  const health = await waitForHealth(port, () => serverError);
  const body = JSON.parse(health.body);
  if (body.desktopAuthenticated !== true || Object.hasOwn(body, "token")) {
    throw new Error("Desktop health authentication contract is unsafe.");
  }

  const anonymous = await request(port, "/api/health");
  const anonymousBody = JSON.parse(anonymous.body);
  if (anonymousBody.desktopAuthenticated !== false || Object.hasOwn(anonymousBody, "token")) {
    throw new Error("Anonymous health response disclosed authentication material.");
  }

  const index = await request(port, "/");
  if (index.status !== 200 || !/Content-Security-Policy/i.test(index.body) || !/frame-ancestors 'none'/i.test(String(index.headers["content-security-policy"] ?? "")) || !/type="module"/i.test(index.body)) {
    throw new Error("Built desktop entry point is missing or malformed.");
  }

  process.stdout.write("Desktop server smoke nominal: isolated data root, authenticated health, CSP, and built entry point.\n");
} finally {
  await stopServer(server);
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
