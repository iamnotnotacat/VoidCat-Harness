# VoidCat secure credential storage

VoidCat stores module credentials through Electron `safeStorage` in the Electron main process. On Windows, Electron protects these values with the current user's DPAPI-backed operating-system encryption. VoidCat never falls back to plaintext when OS encryption is unavailable.

## Storage boundary

- Encrypted file: `.voidcat/secure-credentials.json`
- Repository status: `.voidcat/` is ignored and never committed.
- Plaintext values: never written to disk, logs, settings, localStorage, or the conversation database.
- Names on disk: namespace and key names are visible so they can be listed without decrypting values.
- Renderer access: set, delete, list key names, and encryption-test operations only. The preload bridge deliberately exposes no operation that reveals a stored value.
- Decryption: available only through the main-process `SecureCredentialStore.get()` method. The aisstream maritime connector consumes its token there and returns only normalized vessel observations to React.

## Interface

`SecureCredentialStore` provides:

- `set(namespace, key, value)` — encrypt and persist a value.
- `get(namespace, key)` — decrypt a value in the Electron main process, or return `null`.
- `delete(namespace, key)` — delete only the named credential.
- `list(namespace)` — return sorted key names without values.
- `test()` — perform an in-memory encryption/decryption round trip without persisting the marker.

Namespaces and keys are lowercase identifiers. Hunter-Seeker maritime credentials will use `vc-hunter-seeker.aisstream` and `websocket-token`.

## Usage example

```js
const store = new SecureCredentialStore({ safeStorage, filePath });
store.set("vc-hunter-seeker.aisstream", "websocket-token", suppliedToken);
const token = store.get("vc-hunter-seeker.aisstream", "websocket-token");
store.delete("vc-hunter-seeker.aisstream", "websocket-token");
```

The maritime connector requests the token inside Electron's main process and transmits it only in the provider's required encrypted WebSocket subscription. It does not add a reveal-secret method to the renderer bridge or send the value through a query string.
