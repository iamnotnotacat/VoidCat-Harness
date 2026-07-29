import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function source(file: string) { return readFile(path.join(process.cwd(), file), "utf8"); }

test("Gate 0 records the baseline, isolation, passive policy, authorization, and disposable-data safeguards", async () => {
  const [baseline, architecture, policy, safety, readme, ignore] = await Promise.all([
    source("OSINT_GATE_0_BASELINE.md"), source("OSINT_ARCHITECTURE_ASSESSMENT.md"), source("OSINT_PASSIVE_ONLY_POLICY.md"), source("OSINT_TEST_SAFETY.md"), source("README.md"), source(".gitignore"),
  ]);
  assert.match(baseline, /127 passed, 0 failed, 0 skipped/); assert.match(baseline, /No provider network request was made/); assert.match(baseline, /smaller than 7 GB/);
  assert.match(architecture, /\.voidcat\/data\/osint\//); assert.match(architecture, /osint-investigations/); assert.match(architecture, /loopback provider broker/); assert.match(architecture, /must never select conversations, memories, RAG sources\/vectors, Hunter observations\/history/);
  for (const prohibited of ["Port scanning", "Vulnerability exploitation", "Password guessing", "Automatic recursive investigation", "Automatic creation of Hunter-Seeker watchlists"]) assert.match(policy, new RegExp(prohibited));
  assert.match(policy, /fresh explicit confirmation naming the exact target/); assert.match(safety, /voidcat-osint-test-/); assert.match(safety, /No OSINT database migration[\s\S]*real `\.voidcat`/); assert.match(safety, /only a locally available model smaller than 7 GB/);
  for (const document of ["OSINT_GATE_0_BASELINE.md", "OSINT_ARCHITECTURE_ASSESSMENT.md", "OSINT_PASSIVE_ONLY_POLICY.md", "OSINT_TEST_SAFETY.md", "OSINT_CORE_CONTRACTS.md", "OSINT_MOCKED_VERTICAL_SLICE.md"]) assert.ok(readme.includes(document));
  assert.match(ignore, /^\/\.voidcat\/$/m);
});

test("the desktop launch chain, authenticated health check, visible-window gate, and clean shutdown remain wired", async () => {
  const [launcher, desktop, plugin] = await Promise.all([source("VoidCat Harness.cmd"), source("desktop/main.cjs"), source("build/voidcat-local-plugin.ts")]);
  assert.match(launcher, /release\\VoidCat Harness-win32-x64\\VoidCat Harness\.exe/); assert.match(launcher, /node_modules\\electron\\dist\\electron\.exe/); assert.match(desktop, /await ensureLocalService\(\)/); assert.match(desktop, /mainWindow\.once\("ready-to-show"/); assert.match(desktop, /mainWindow\.on\("close", cleanupLocalResources\)/);
  assert.match(desktop, /VOIDCAT_DESKTOP_TOKEN/); assert.match(plugin, /url === "\/api\/health"/); assert.match(plugin, /app: "voidcat-harness"/);
});

test("Gate 1 and Gate 2 remain structurally unable to contact providers or persist data", async () => {
  const files = [
    "build/osint/contracts.ts", "build/osint/provider-contracts.ts", "build/osint/policy-and-planner.ts", "build/osint/hunter-seeker-intake.ts",
    "build/osint/mock-providers.ts", "build/osint/correlation-and-confidence.ts", "build/osint/mock-investigation-runtime.ts",
  ];
  const joined = (await Promise.all(files.map(source))).join("\n");
  for (const forbidden of [/\bfetch\s*\(/, /node:https?/, /node:(?:net|tls|dns)/, /DatabaseSync/, /writeFile/, /appendFile/, /safeStorage/, /credentialStore/]) assert.doesNotMatch(joined, forbidden);
  const packageSource = await source("package.json"); assert.match(packageSource, /tests\/osint-core-contracts\.test\.ts/); assert.match(packageSource, /tests\/osint-mocked-vertical-slice\.test\.ts/); assert.match(packageSource, /tests\/osint-gates-zero-readiness\.test\.ts/);
});
