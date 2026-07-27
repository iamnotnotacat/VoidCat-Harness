import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const MINIMUM_FONT_SIZE_PX = 10;
const CSS_FILES = ["app/design-tokens.css", "app/globals.css"];

test("application typography never declares text below the 10px floor", () => {
  for (const relativePath of CSS_FILES) {
    const css = readFileSync(join(process.cwd(), relativePath), "utf8");
    const declarations = [...css.matchAll(/font-size\s*:\s*([0-9]+(?:\.[0-9]+)?)px/g)];

    for (const declaration of declarations) {
      const size = Number(declaration[1]);
      assert.ok(
        size >= MINIMUM_FONT_SIZE_PX,
        `${relativePath} declares ${size}px text, below the ${MINIMUM_FONT_SIZE_PX}px floor.`,
      );
    }
  }
});

test("shared compact typography tokens respect the 10px floor", () => {
  const tokens = readFileSync(join(process.cwd(), "app/design-tokens.css"), "utf8");

  for (const token of ["micro", "caption", "control", "label"]) {
    const match = tokens.match(new RegExp(`--vc-type-${token}:\\s*([0-9]+(?:\\.[0-9]+)?)px`));
    assert.ok(match, `Missing --vc-type-${token}.`);
    assert.ok(Number(match[1]) >= MINIMUM_FONT_SIZE_PX, `--vc-type-${token} is below 10px.`);
  }
});
