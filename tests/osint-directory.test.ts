/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { OSINT4ALL_CATEGORIES, OSINT4ALL_LINKS, OSINT4ALL_SOURCE_URL, describeOsintDirectoryEntry, searchOsintDirectory } from "../app/osint4all-links.ts";

const expectedCounts: Readonly<Record<string, number>> = {
  "THROWAWAY CONTACT": 17, "ID GENERATOR": 33, "UNIFIED SEARCH": 13, PEOPLE: 26, USERNAME: 19, EMAIL: 26, PHONE: 27,
  "SOCIAL MEDIA": 15, FACEBOOK: 16, TWITTER: 40, "SEARCH ENGINES": 70, "GOOGLE CSE": 19, MAPS: 47, GEO: 18,
};

test("the OSINT4All snapshot contains every unique rendered destination from all fourteen source widgets", () => {
  assert.equal(OSINT4ALL_SOURCE_URL, "https://start.me/p/L1rEYQ/osint4all");
  assert.equal(OSINT4ALL_LINKS.length, 386); assert.equal(OSINT4ALL_CATEGORIES.length, 14);
  assert.deepEqual(Object.fromEntries(OSINT4ALL_CATEGORIES.map((category) => [category, OSINT4ALL_LINKS.filter((entry) => entry.category === category).length])), expectedCounts);
  const hash = createHash("sha256").update(JSON.stringify(OSINT4ALL_LINKS.map(({ category, name, url }) => ({ category, name, url })))).digest("hex");
  assert.equal(hash, "68d414d897d01e84a5470d430a394c4139987899f3123d064259749a2d91104b");
});

test("directory entries have unique identities, bounded web URLs, and a visible description", () => {
  assert.equal(new Set(OSINT4ALL_LINKS.map(({ id }) => id)).size, OSINT4ALL_LINKS.length);
  for (const entry of OSINT4ALL_LINKS) {
    assert.ok(entry.name.trim().length > 0); assert.ok(OSINT4ALL_CATEGORIES.includes(entry.category as typeof OSINT4ALL_CATEGORIES[number]));
    const url = new URL(entry.url); assert.ok(["http:", "https:"].includes(url.protocol)); assert.equal(url.username, ""); assert.equal(url.password, "");
    const description = describeOsintDirectoryEntry(entry); assert.ok(description.length >= 40); assert.match(description, new RegExp(entry.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("natural-language directory aliases return deterministic cited candidates", () => {
  const first = searchOsintDirectory("geolocation tools", 20); const second = searchOsintDirectory("geolocation tools", 20);
  assert.deepEqual(first, second); assert.ok(first.length > 0); assert.ok(first.every(({ category }) => category === "GEO" || category === "MAPS"));
  assert.ok(searchOsintDirectory("GeoPlatform", 20).some(({ name }) => /geoplatform/i.test(name)));
});

test("the app exposes a dedicated searchable directory tab with safe external-link behavior", () => {
  const root = process.cwd(); const panel = readFileSync(join(root, "app", "OsintDirectoryPanel.tsx"), "utf8"); const consoleSource = readFileSync(join(root, "app", "VoidCatConsole.tsx"), "utf8");
  for (const label of ["OSINT4ALL TOOL MATRIX", "SEARCH ALL TOOLS", "EXTERNAL // NOT VETTED BY VOIDCAT", "OPEN SOURCE BOARD", "OSINT DIRECTORY"]) assert.ok(`${panel}\n${consoleSource}`.includes(label));
  assert.match(consoleSource, /view === "osint-directory"/); assert.match(consoleSource, /<OsintDirectoryPanel/); assert.match(consoleSource, /<span>05<\/span> OSINT DIRECTORY/);
  assert.match(panel, /target="_blank" rel="noopener noreferrer"/); assert.match(panel, /Opening a link never adds it to an investigation or sends it to a UNIT/); assert.match(panel, /LEGACY HTTP BLOCKED/); assert.match(panel, /HTTP BLOCKED/);
});

test("the large catalog uses bounded internal scrolling and screen-aware layouts", () => {
  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8"); const directoryCss = css.slice(css.indexOf("OSINT4All external research directory"));
  assert.match(directoryCss, /content-visibility:auto/); assert.match(directoryCss, /overflow-y:auto/); assert.match(directoryCss, /scrollbar-color:var\(--vc-accent-highlight\)/); assert.match(directoryCss, /@media\(max-width:1100px\)/); assert.match(directoryCss, /@media\(max-width:800px\)/);
  assert.doesNotMatch(directoryCss, /font-size:\s*(?:[0-9]|[0-9]\.[0-9]+)px/);
});
