const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 256;
const MAX_SECRET_BYTES = 32 * 1024;
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,95}$/;

function validateName(value, label) {
  if (typeof value !== "string" || !NAME_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase identifier containing only letters, numbers, dots, underscores, and hyphens.`);
  }
  return value;
}

function entryId(namespace, key) {
  return `${validateName(namespace, "Credential namespace")}::${validateName(key, "Credential key")}`;
}

function emptyDocument() {
  return { version: STORE_VERSION, entries: {} };
}

class SecureCredentialStore {
  constructor(options) {
    if (!options?.safeStorage || typeof options.safeStorage.isEncryptionAvailable !== "function") {
      throw new Error("Electron safeStorage is required for secure credential storage.");
    }
    if (!options.filePath || !path.isAbsolute(options.filePath)) {
      throw new Error("Secure credential storage requires an absolute file path.");
    }
    this.safeStorage = options.safeStorage;
    this.filePath = options.filePath;
  }

  assertAvailable() {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is unavailable on this system. VoidCat will not fall back to plaintext storage.");
    }
  }

  readDocument() {
    if (!fs.existsSync(this.filePath)) return emptyDocument();
    const metadata = fs.lstatSync(this.filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("Secure credential storage path is not a regular file.");
    if (metadata.size > MAX_STORE_BYTES) throw new Error("Secure credential storage exceeds its safety limit.");
    let document;
    try { document = JSON.parse(fs.readFileSync(this.filePath, "utf8")); }
    catch { throw new Error("Secure credential storage is corrupted or unreadable."); }
    if (document?.version !== STORE_VERSION || !document.entries || Array.isArray(document.entries) || typeof document.entries !== "object") {
      throw new Error("Secure credential storage has an unsupported or corrupted format.");
    }
    const entries = Object.entries(document.entries);
    if (entries.length > MAX_ENTRIES) throw new Error("Secure credential storage contains too many entries.");
    for (const [id, entry] of entries) {
      if (!id.includes("::") || !entry || typeof entry !== "object" || typeof entry.ciphertext !== "string" || typeof entry.updatedAt !== "string") {
        throw new Error("Secure credential storage contains an invalid entry.");
      }
      if (entry.ciphertext.length > MAX_SECRET_BYTES * 4 || !Number.isFinite(Date.parse(entry.updatedAt))) {
        throw new Error("Secure credential storage contains an invalid entry.");
      }
    }
    return document;
  }

  writeDocument(document) {
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error("Secure credential storage exceeds its safety limit.");
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporaryPath, this.filePath);
      try { fs.chmodSync(this.filePath, 0o600); } catch { /* Windows ACLs remain authoritative. */ }
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch { /* The temporary file may not have been created. */ }
      throw error;
    }
  }

  set(namespace, key, value) {
    this.assertAvailable();
    if (typeof value !== "string" || value.length === 0) throw new Error("Credential value cannot be empty.");
    if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) throw new Error("Credential value exceeds the 32 KiB safety limit.");
    const id = entryId(namespace, key);
    const document = this.readDocument();
    if (!document.entries[id] && Object.keys(document.entries).length >= MAX_ENTRIES) {
      throw new Error("Secure credential storage has reached its entry limit.");
    }
    const encrypted = this.safeStorage.encryptString(value);
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error("The operating system did not encrypt the credential.");
    document.entries[id] = { ciphertext: encrypted.toString("base64"), updatedAt: new Date().toISOString() };
    this.writeDocument(document);
    return { namespace, key, stored: true };
  }

  get(namespace, key) {
    this.assertAvailable();
    const entry = this.readDocument().entries[entryId(namespace, key)];
    if (!entry) return null;
    try { return this.safeStorage.decryptString(Buffer.from(entry.ciphertext, "base64")); }
    catch { throw new Error("The operating system could not decrypt this credential for the current user."); }
  }

  delete(namespace, key) {
    this.assertAvailable();
    const id = entryId(namespace, key);
    const document = this.readDocument();
    if (!document.entries[id]) return false;
    delete document.entries[id];
    this.writeDocument(document);
    return true;
  }

  list(namespace) {
    this.assertAvailable();
    const prefix = `${validateName(namespace, "Credential namespace")}::`;
    return Object.keys(this.readDocument().entries)
      .filter((id) => id.startsWith(prefix))
      .map((id) => id.slice(prefix.length))
      .sort();
  }

  describe(namespace, key) {
    const value = this.get(namespace, key);
    if (value === null) return { stored: false, fingerprint: null, updatedAt: null };
    const entry = this.readDocument().entries[entryId(namespace, key)];
    const fingerprint = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8).toUpperCase();
    return { stored: true, fingerprint: `•••• ${fingerprint}`, updatedAt: entry.updatedAt };
  }

  test() {
    this.assertAvailable();
    const marker = `voidcat-safe-storage-test:${randomUUID()}`;
    const encrypted = this.safeStorage.encryptString(marker);
    const decrypted = this.safeStorage.decryptString(encrypted);
    if (decrypted !== marker) throw new Error("Secure credential storage failed its encryption round trip.");
    return { available: true, backend: process.platform === "win32" ? "windows-dpapi" : "os-protected" };
  }
}

module.exports = { SecureCredentialStore };
