const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { SecureCredentialStore } = require("../desktop/secure-credential-store.cjs");

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`sealed:${[...value].reverse().join("")}`, "utf8"),
    decryptString: (value) => {
      const encoded = value.toString("utf8");
      if (!encoded.startsWith("sealed:")) throw new Error("invalid ciphertext");
      return [...encoded.slice(7)].reverse().join("");
    },
  };
}

function withTemporaryStore(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "voidcat-credentials-"));
  const filePath = path.join(directory, "secure-credentials.json");
  try { return run({ directory, filePath }); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test("secure credentials encrypt values, isolate namespaces, and list keys only", () => withTemporaryStore(({ filePath }) => {
  const store = new SecureCredentialStore({ safeStorage: fakeSafeStorage(), filePath });
  assert.deepEqual(store.test(), { available: true, backend: process.platform === "win32" ? "windows-dpapi" : "os-protected" });
  store.set("vc-hunter-seeker.aisstream", "websocket-token", "top-secret-token");
  store.set("another-module", "api-key", "separate-secret");

  assert.equal(store.get("vc-hunter-seeker.aisstream", "websocket-token"), "top-secret-token");
  assert.equal(store.get("vc-hunter-seeker.aisstream", "missing-key"), null);
  assert.deepEqual(store.list("vc-hunter-seeker.aisstream"), ["websocket-token"]);
  const description = store.describe("vc-hunter-seeker.aisstream", "websocket-token");
  assert.equal(description.stored, true);
  assert.match(description.fingerprint, /^•••• [0-9A-F]{8}$/);
  assert.equal(JSON.stringify(description).includes("top-secret-token"), false);
  const diskText = fs.readFileSync(filePath, "utf8");
  assert.doesNotMatch(diskText, /top-secret-token|separate-secret/);
  assert.match(diskText, /ciphertext/);

  assert.equal(store.delete("vc-hunter-seeker.aisstream", "websocket-token"), true);
  assert.equal(store.delete("vc-hunter-seeker.aisstream", "websocket-token"), false);
  assert.equal(store.get("vc-hunter-seeker.aisstream", "websocket-token"), null);
  assert.deepEqual(store.describe("vc-hunter-seeker.aisstream", "websocket-token"), { stored: false, fingerprint: null, updatedAt: null });
}));

test("secure credentials fail closed when OS encryption is unavailable", () => withTemporaryStore(({ filePath }) => {
  const store = new SecureCredentialStore({ safeStorage: fakeSafeStorage(false), filePath });
  assert.throws(() => store.set("vc-hunter-seeker.aisstream", "websocket-token", "secret"), /will not fall back to plaintext/i);
  assert.equal(fs.existsSync(filePath), false);
}));

test("secure credentials reject corrupted storage without overwriting it", () => withTemporaryStore(({ filePath }) => {
  fs.writeFileSync(filePath, "not-json", "utf8");
  const store = new SecureCredentialStore({ safeStorage: fakeSafeStorage(), filePath });
  assert.throws(() => store.list("vc-hunter-seeker.aisstream"), /corrupted or unreadable/i);
  assert.equal(fs.readFileSync(filePath, "utf8"), "not-json");
}));
