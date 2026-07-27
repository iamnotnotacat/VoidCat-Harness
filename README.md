# VoidCat Harness

VoidCat Harness is a local-first Windows desktop interface for GGUF UNITs downloaded through LM Studio. It discovers UNITs from the LM Studio library, runs them through the headless local runtime, and automatically ejects VoidCat-owned UNITs when the app closes.

## Launch

Double-click **VoidCat Harness** in this folder. The shortcut opens the Electron desktop app; LM Studio does not need to be open.

## Included systems

- Local UNIT discovery, initialization, streaming chat, and clean shutdown
- Persistent SQLite conversations, profiles, and operator-approved memories
- Relevance- and priority-ranked memory retrieval
- `remember this: ...` and `forget this: ...` chat commands
- Optional memory suggestions that always require approval
- Local RAG library for PDF, DOCX, TXT, and Markdown files
- No app-imposed RAG document size cap; practical capacity depends on available memory and disk space
- Web search through DuckDuckGo, Brave Search, or Tavily
- Per-conversation web modes: OFF, ASK, and AUTO
- Expandable web citations with title, URL, quoted evidence, and filtering notices

## Web safeguards

VoidCat allows only HTTP/HTTPS text pages. It blocks local/private network addresses, credentialed URLs, binary downloads, oversized responses, excess redirects, blocked domains, and destinations outside an optional allowlist. Webpage content is treated as untrusted evidence; instruction-like text is removed before it enters a UNIT's context.

DuckDuckGo works without a key. Brave Search and Tavily keys can be entered under **07 WEB ACCESS**. Keys are never returned to the interface after storage.

## Local data

Persistent data is stored under `.voidcat/data/voidcat.db`. Indexed document copies are stored under `.voidcat/library/files`.

## Development

Requires Node.js 22.13 or newer.

```powershell
npm install
npm run dev
npm run build
```
