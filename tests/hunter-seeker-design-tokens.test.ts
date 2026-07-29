/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const colorLiteral = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi;
const namedPresentationColor = /(?<![-\w])(?:aliceblue|aqua|black|blue|cyan|fuchsia|gray|green|lime|magenta|maroon|navy|olive|orange|purple|red|silver|teal|white|yellow)(?![-\w])/gi;

test("Hunter-Seeker component rules use shared semantic color tokens", () => {
  const css = readFileSync(join(root, "app/globals.css"), "utf8");
  const violations: string[] = [];

  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().split("\n").at(-1)?.trim() ?? "";
    if (!selector.includes("hunter-")) continue;
    const literals = match[2].match(colorLiteral);
    if (literals?.length) violations.push(`${selector}: ${[...new Set(literals)].join(", ")}`);
    const named = match[2].match(namedPresentationColor);
    if (named?.length) violations.push(`${selector}: ${[...new Set(named)].join(", ")}`);
  }

  assert.deepEqual(violations, [], `Hunter-Seeker rules contain raw colors:\n${violations.join("\n")}`);
});

test("Hunter-Seeker renderer code reads semantic tokens instead of embedding colors", () => {
  const relativePaths = readdirSync(join(root, "app"))
    .filter((name) => /^(?:HunterSeeker|hunter-seeker|HunterErrorBoundary|OverflowMarquee).+\.(?:ts|tsx)$/.test(name))
    .map((name) => `app/${name}`);
  for (const relativePath of relativePaths) {
    const source = readFileSync(join(root, relativePath), "utf8");
    assert.equal(colorLiteral.test(source), false, `${relativePath} embeds a raw presentation color.`);
    colorLiteral.lastIndex = 0;
  }
});

test("Hunter-Seeker declares compact and narrow screen recovery layouts", () => {
  const css = readFileSync(join(root, "app/globals.css"), "utf8");
  assert.match(css, /@media\s*\(max-width:\s*(?:900|1100)px\)/i);
  assert.match(css, /@media\s*\(max-height:/i);
  assert.match(css, /hunter-board[\s\S]{0,500}(?:grid-template|overflow)/i);
});

test("the shared token source and design contract expose required semantic roles", () => {
  const tokens = readFileSync(join(root, "app/design-tokens.css"), "utf8");
  const contract = readFileSync(join(root, "docs", "hunter-seeker", "DESIGN_TOKENS.md"), "utf8");
  const requiredTokens = [
    "--vc-surface-canvas",
    "--vc-surface-panel",
    "--vc-surface-scrim",
    "--vc-text-primary",
    "--vc-text-critical",
    "--vc-accent-primary",
    "--vc-accent-highlight",
    "--vc-status-warning",
    "--vc-status-critical",
    "--vc-intel-military-aircraft",
    "--vc-intel-civilian-aircraft",
    "--vc-intel-maritime",
    "--vc-intel-infrastructure",
    "--vc-intel-space",
    "--vc-intel-stale",
    "--vc-map-background",
    "--vc-type-micro",
    "--vc-motion-standard",
  ];

  for (const token of requiredTokens) {
    assert.match(tokens, new RegExp(`${token.replaceAll("-", "\\-")}\\s*:`), `Missing ${token}.`);
  }
  assert.match(contract, /No rendered application text may be smaller than 10px/i);
  assert.match(contract, /prefers-reduced-motion/i);
});

test("custom map attribution remains visible and documented", () => {
  const panel = readFileSync(join(root, "app/HunterSeekerPanel.tsx"), "utf8");
  const map = readFileSync(join(root, "app/HunterSeekerMap.tsx"), "utf8");
  const attribution = readFileSync(join(root, "docs", "hunter-seeker", "DATA_ATTRIBUTION.md"), "utf8");

  assert.match(map, /attributionControl:\s*false/);
  for (const provider of ["OPENFREEMAP", "OPENMAPTILES", "OPENSTREETMAP"]) {
    assert.match(panel, new RegExp(provider));
    assert.match(attribution, new RegExp(provider, "i"));
  }
  assert.match(attribution, /map footer/i);
});
