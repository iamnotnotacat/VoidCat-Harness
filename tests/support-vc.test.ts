/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SUPPORT_VC_LINKS } from "../app/support-vc-links.ts";

test("SUPPORT_VC keeps exact editable content in one config array", () => {
  assert.equal(SUPPORT_VC_LINKS.length, 3); assert.equal(SUPPORT_VC_LINKS.filter(({ primary }) => primary).length, 1);
  assert.deepEqual(SUPPORT_VC_LINKS.map(({ url }) => url), ["https://cash.app/$rabbitinthehand", "https://library.iamnotnotacat.com", "https://iamnotnotacat.com"]);
  assert.equal(SUPPORT_VC_LINKS[0].handle, "$rabbitinthehand");
  for (const item of SUPPORT_VC_LINKS) { const url = new URL(item.url); assert.equal(url.protocol, "https:"); assert.ok(item.description.length > 60); }
});

test("SUPPORT_VC is reachable, safe, accessible, responsive, and tracking-free", () => {
  const root = process.cwd(); const panel = readFileSync(join(root, "app", "SupportVcPanel.tsx"), "utf8"); const consoleSource = readFileSync(join(root, "app", "VoidCatConsole.tsx"), "utf8"); const css = readFileSync(join(root, "app", "globals.css"), "utf8");
  assert.match(consoleSource, /<span>16<\/span> SUPPORT_VC/); assert.match(consoleSource, /view === "support-vc"/); assert.match(consoleSource, /<SupportVcPanel/);
  assert.match(panel, /target="_blank" rel="noopener noreferrer"/); assert.match(panel, /navigator\.clipboard\.writeText/); assert.match(panel, /Copied!/); assert.match(panel, /aria-live="polite"/); assert.match(panel, /aria-label=/); assert.match(panel, /NO TRACKING/); assert.doesNotMatch(panel, /\b(?:gtag|track|identify)\s*\(|analytics\./i); assert.doesNotMatch(panel, /<script/i);
  const supportCss = css.slice(css.indexOf("Voluntary support links")); assert.match(supportCss, /\.support-vc-card\.primary/); assert.match(supportCss, /:focus-visible/); assert.match(supportCss, /min-height:4[68]px/); assert.match(supportCss, /@media\(max-width:800px\)/); assert.match(supportCss, /grid-template-columns:1fr/);
});
