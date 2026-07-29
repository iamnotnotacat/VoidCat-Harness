# Security policy

## Supported version

Security fixes target the latest published VoidCat Harness release and the current `main` branch. Older portable builds may not receive fixes; reproduce the issue on the latest release when it is safe to do so.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/iamnotnotacat/VoidCat-Harness/security/advisories/new). Do not disclose a suspected vulnerability in a public issue, discussion, screenshot, or investigation report.

Include a concise description, affected version, reproduction steps, impact, and a proposed mitigation if you have one. Remove all API keys, passwords, authorization headers, private documents, personal paths, model files, database contents, and real investigation targets. A maintainer will acknowledge a complete report as capacity permits and coordinate disclosure after a fix is available.

## Security boundaries

VoidCat is designed around these boundaries:

- Chats, approved memories, RAG documents, embeddings, project data, and local voice processing remain on the computer by default.
- Only explicitly enabled provider requests, web searches, webpage fetches, model downloads, or operator-approved pulls leave the computer.
- Provider credentials are handled in Electron's protected main process and must not enter renderer state, URLs, logs, databases, reports, or UNIT context.
- Web and provider content is untrusted evidence. It must not be treated as application instructions.
- OSINT operation is passive-only: no scanning, exploitation, credential guessing, recursive autonomous expansion, or unauthorized exposure checking.
- Test migrations, eviction, and stress work must use disposable databases. Never test destructive storage behavior against a user's live data.

These are design goals, not a guarantee that the software is free of defects. VoidCat is provided without warranty under CPAL-1.0.
