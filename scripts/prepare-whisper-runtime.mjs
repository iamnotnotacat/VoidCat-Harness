import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const runtimeRoot = join(root, "vendor", "whisper", "windows-x64");
const executablePath = join(runtimeRoot, "Release", "whisper-cli.exe");
const modelPath = join(runtimeRoot, "models", "ggml-tiny.en-q5_1.bin");
const archiveUrl = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip";
const archiveSha256 = "7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539";
const modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en-q5_1.bin?download=true";
const modelSha1 = "3fb92ec865cbbc769f08137f22470d6b66e071b6";

function digest(file, algorithm) {
  return createHash(algorithm).update(readFileSync(file)).digest("hex");
}

async function download(url, target) {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.download`;
  rmSync(temporary, { force: true });
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Voice runtime download failed with HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 100 * 1024 * 1024) throw new Error("Voice runtime download exceeded the 100 MB safety limit.");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(temporary, bytes));
  renameSync(temporary, target);
}

async function prepareEngine() {
  if (existsSync(executablePath)) return;
  const archive = join(runtimeRoot, "whisper-bin-x64.zip");
  await download(archiveUrl, archive);
  if (digest(archive, "sha256") !== archiveSha256) throw new Error("The downloaded whisper.cpp archive failed its SHA-256 check.");
  const expanded = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath $env:VC_ARCHIVE -DestinationPath $env:VC_DEST -Force"], {
    windowsHide: true,
    env: { ...process.env, VC_ARCHIVE: archive, VC_DEST: runtimeRoot },
    stdio: "inherit",
  });
  rmSync(archive, { force: true });
  if (expanded.status !== 0 || !existsSync(executablePath)) {
    const found = readdirSync(runtimeRoot, { recursive: true }).find((entry) => String(entry).toLowerCase().endsWith("whisper-cli.exe"));
    throw new Error(`whisper.cpp extraction failed${found ? `; unexpected executable path ${found}` : ""}.`);
  }
}

async function prepareModel() {
  if (existsSync(modelPath) && digest(modelPath, "sha1") === modelSha1) return;
  rmSync(modelPath, { force: true });
  await download(modelUrl, modelPath);
  if (digest(modelPath, "sha1") !== modelSha1) {
    rmSync(modelPath, { force: true });
    throw new Error("The downloaded Whisper model failed its official SHA-1 check.");
  }
}

if (process.platform !== "win32") throw new Error("The bundled voice preparation script currently targets the Windows desktop package.");
await prepareEngine();
await prepareModel();
console.log(`Bundled local voice ready: ${executablePath}`);
