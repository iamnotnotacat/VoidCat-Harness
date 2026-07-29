# OSINT4All Directory

VoidCat's **11 OSINT DIRECTORY** page is a searchable local reference snapshot of the public [OSINT4All Start.me board](https://start.me/p/L1rEYQ/osint4all).

## Snapshot scope

- Captured: 2026-07-28
- Source widgets: 14
- Bookmark links: 387
- Categories: Throwaway Contact, ID Generator, Unified Search, People, Username, Email, Phone, Social Media, Facebook, Twitter, Search Engines, Google CSE, Maps, and Geo
- Integrity: the test suite pins the category counts and a SHA-256 checksum of category, name, and URL fields so accidental omissions are detected.

VoidCat-authored descriptions identify the category, displayed name, and host for every entry. They do not copy long descriptions from the source board and do not claim that a service is trustworthy, accurate, available, lawful in every jurisdiction, or suitable for a particular investigation.

## Operator behavior

- Search matches tool name, category, domain, and description.
- Category controls filter the catalog without removing entries from the snapshot.
- HTTPS and insecure HTTP destinations are visibly distinguished.
- Links open in the system browser through Electron's denied-window handler; they do not navigate the VoidCat renderer.
- Opening a link does not start an OSINT investigation, contact a VoidCat provider, submit data to a UNIT, create a lead, or persist a record.
- The original board remains available through **OPEN SOURCE BOARD** so operators can compare against later source changes.

## Safety boundary

OSINT4All is externally curated and is not vetted or endorsed by VoidCat. Some destinations may be obsolete, unsafe, intrusive, account-gated, restricted by terms, or inappropriate without authorization. Operators must review each destination, its jurisdiction, terms, and intended use before interacting with it.

The catalog is reference-only. It is not added to the provider registry, active-UNIT tool registry, Hunter-Seeker source matrix, or controlled-expansion system.

## Updating the snapshot

Refreshes must be deliberate. Recount every rendered `bookmark-item__link`, preserve category order, regenerate the integrity checksum, review new insecure-HTTP entries, rerun `tests/osint-directory.test.ts`, and complete the full VoidCat regression suite before accepting an update.
