# Contributing to VoidCat Harness

Thank you for helping improve VoidCat. Changes should preserve its local-first privacy model, bounded resource use, passive-only OSINT policy, and inspectable evidence chain.

## Development setup

Use Windows 10 or 11 with Node.js 22.13 or newer. Node.js 24 is used by continuous integration.

```powershell
git clone https://github.com/iamnotnotacat/VoidCat-Harness.git
cd "VoidCat-Harness"
npm ci
npm test
npm run dev
```

Open a focused pull request from a feature branch. Describe the user-visible behavior, tests performed, privacy or network effects, and any migration or storage impact. Update operator documentation whenever behavior changes.

## Required safety rules

- Never commit credentials, `.env` files, databases, private documents, generated embeddings, model weights, runtime logs, packaged applications, or investigation evidence.
- Use fixtures before live providers. Any manual live check must be bounded, passive, authorized, and documented without secrets.
- Use disposable databases for migrations, eviction, recovery, or stress testing. Never target a user's `.voidcat` directory.
- Do not load a UNIT during infrastructure tests. When model integration is necessary, use a local UNIT smaller than 7 GB.
- Preserve chat, memory, RAG, Hunter-Seeker history, and OSINT storage isolation.
- All external calls need explicit availability, cadence, request, cache, and cancellation limits.
- New factual intelligence conclusions require evidence identifiers and provenance; uncited conclusions must be marked unsupported.

## Verification

Run the complete suite before opening a pull request:

```powershell
npm test
```

The suite performs strict type checking, linting, offline-safe contract and integration tests, and a production build. Live-provider and UNIT tests are intentionally separate and must not be added to the default suite.

By submitting a contribution, you agree that it may be distributed under the repository's CPAL-1.0 license and that the Exhibit B attribution requirements remain applicable.
