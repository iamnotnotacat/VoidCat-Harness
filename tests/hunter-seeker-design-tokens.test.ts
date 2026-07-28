import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const colorLiteral = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi;

test("Hunter-Seeker component rules use shared semantic color tokens", () => {
  const css = readFileSync(join(root, "app/globals.css"), "utf8");
  const violations: string[] = [];

  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().split("\n").at(-1)?.trim() ?? "";
    if (!selector.includes("hunter-")) continue;
    const literals = match[2].match(colorLiteral);
    if (literals?.length) violations.push(`${selector}: ${[...new Set(literals)].join(", ")}`);
  }

  assert.deepEqual(violations, [], `Hunter-Seeker rules contain raw colors:\n${violations.join("\n")}`);
});

test("Hunter-Seeker renderer code reads semantic tokens instead of embedding colors", () => {
  for (const relativePath of [
    "app/HunterSeekerMap.tsx",
    "app/HunterSeekerPanel.tsx",
    "app/HunterSeekerCredentialModal.tsx",
    "app/HunterErrorBoundary.tsx",
  ]) {
    const source = readFileSync(join(root, relativePath), "utf8");
    assert.equal(colorLiteral.test(source), false, `${relativePath} embeds a raw presentation color.`);
    colorLiteral.lastIndex = 0;
  }
});

test("the shared token source and design contract expose required semantic roles", () => {
  const tokens = readFileSync(join(root, "app/design-tokens.css"), "utf8");
  const contract = readFileSync(join(root, "DESIGN_TOKENS.md"), "utf8");
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
  const attribution = readFileSync(join(root, "DATA_ATTRIBUTION.md"), "utf8");

  assert.match(map, /attributionControl:\s*false/);
  for (const provider of ["OPENFREEMAP", "OPENMAPTILES", "OPENSTREETMAP"]) {
    assert.match(panel, new RegExp(provider));
    assert.match(attribution, new RegExp(provider, "i"));
  }
  assert.match(attribution, /map footer/i);
});
