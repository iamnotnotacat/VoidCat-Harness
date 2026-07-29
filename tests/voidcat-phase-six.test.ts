/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { COMMAND_TOOLS } from "../app/command-tool-definitions.ts";
import { conditionSpeechSamples, encodeMonoWav, resampleMono } from "../app/voice-audio.ts";
import { parseNewsFeed, refreshNews, VOIDCAT_NEWS_SOURCES } from "../build/voidcat-news.ts";
import { OsintStore, OsintStoreError } from "../build/osint/osint-store.ts";

test("boot sequence holds for 3.5 seconds and presents the doubled brand mark", () => {
  const consoleSource = readFileSync(join(process.cwd(), "app", "VoidCatConsole.tsx"), "utf8");
  const styles = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");

  assert.match(consoleSource, /const BOOT_DURATION_MS = 3_500/);
  assert.match(consoleSource, /setTimeout\(\(\) => setBooted\(true\), BOOT_DURATION_MS\)/);
  assert.match(consoleSource, /className="boot-scan-grid"/);
  assert.match(consoleSource, /className="boot-orbit boot-orbit-outer"/);
  assert.match(styles, /\.boot-mark\{[^}]*width:192px;height:192px/);
  assert.match(styles, /@keyframes boot-sweep/);
  assert.match(styles, /@keyframes boot-logo-materialize/);
  assert.match(styles, /@media\(prefers-reduced-motion:reduce\)/);
});

test("Command exposes exact independently selectable capabilities with visible external classifications", () => {
  assert.equal(new Set(COMMAND_TOOLS.map(({ name }) => name)).size, COMMAND_TOOLS.length);
  assert.ok(COMMAND_TOOLS.some(({ name }) => name === "hunter-seeker.vessels-in-bbox")); assert.ok(COMMAND_TOOLS.some(({ name }) => name === "osint-unit.explain-claim-or-confidence")); assert.ok(COMMAND_TOOLS.some(({ name }) => name === "voidcat.news-headlines"));
  assert.ok(COMMAND_TOOLS.filter(({ access }) => access === "EXTERNAL").length > 1); assert.ok(COMMAND_TOOLS.filter(({ access }) => access === "LOCAL").length > 1);
});

test("local microphone output is bounded 16-bit mono WAV resampled to Whisper's 16 kHz input", () => {
  const source = Float32Array.from({ length: 48_000 }, (_, index) => Math.sin(index / 20)); const samples = resampleMono(source, 48_000); assert.equal(samples.length, 16_000);
  const wav = encodeMonoWav(samples); const view = new DataView(wav); assert.equal(Buffer.from(wav.slice(0, 4)).toString("ascii"), "RIFF"); assert.equal(Buffer.from(wav.slice(8, 12)).toString("ascii"), "WAVE"); assert.equal(view.getUint16(22, true), 1); assert.equal(view.getUint32(24, true), 16_000); assert.equal(view.getUint16(34, true), 16);
});

test("local microphone conditioning rejects silence, trims dead air, and raises quiet speech", () => {
  assert.throws(() => conditionSpeechSamples(new Float32Array(48_000), 48_000), /No usable microphone signal/);
  const recording = new Float32Array(96_000);
  for (let index = 24_000; index < 72_000; index += 1) recording[index] = Math.sin(index / 13) * 0.04;
  const conditioned = conditionSpeechSamples(recording, 48_000);
  assert.ok(conditioned.length < recording.length);
  assert.ok(Math.max(...conditioned) > 0.15);
});

test("voice capture is toggle-only, serialized, and granted only to local audio", () => {
  const controls = readFileSync(join(process.cwd(), "app", "VoiceControls.tsx"), "utf8");
  const audio = readFileSync(join(process.cwd(), "app", "voice-audio.ts"), "utf8");
  const settings = readFileSync(join(process.cwd(), "app", "AppSettingsPanel.tsx"), "utf8");
  const consoleSource = readFileSync(join(process.cwd(), "app", "VoidCatConsole.tsx"), "utf8");
  const database = readFileSync(join(process.cwd(), "build", "voidcat-database.ts"), "utf8");
  const desktop = readFileSync(join(process.cwd(), "desktop", "main.cjs"), "utf8");
  assert.match(controls, /aria-pressed=\{recording\}/);
  assert.match(controls, /STOP \+ TRANSCRIBE/);
  assert.doesNotMatch(controls, /onPointerDown|onPointerUp|HOLD TO TALK/);
  assert.match(controls, /operationActive/);
  assert.match(consoleSource, /voiceInputMode: "toggle"/);
  assert.match(database, /voiceInputMode: "toggle" as const/);
  assert.match(database, /voiceInputDeviceId/);
  assert.match(database, /voiceOutputDeviceId/);
  assert.match(settings, /DETECT AUDIO DEVICES/);
  assert.match(settings, /WINDOWS DEFAULT INPUT/);
  assert.match(settings, /WINDOWS DEFAULT OUTPUT/);
  assert.match(audio, /deviceId: this\.inputDeviceId \? \{ exact: this\.inputDeviceId \}/);
  assert.match(desktop, /setPermissionCheckHandler/);
  assert.match(desktop, /mediaTypes\.includes\("audio"\)/);
  assert.match(desktop, /!mediaTypes\.includes\("video"\)/);
  assert.match(desktop, /GetAudioOutputs/);
  assert.match(desktop, /VOIDCAT_SPEECH_OUTPUT/);
});

test("the Windows package prepares a checksum-pinned bundled Whisper runtime with custom overrides remaining optional", () => {
  const packageJson = readFileSync(join(process.cwd(), "package.json"), "utf8"); const prepare = readFileSync(join(process.cwd(), "scripts", "prepare-whisper-runtime.mjs"), "utf8"); const trim = readFileSync(join(process.cwd(), "scripts", "trim-packaged-runtime.mjs"), "utf8"); const launcher = readFileSync(join(process.cwd(), "scripts", "update-windows-launcher.ps1"), "utf8"); const main = readFileSync(join(process.cwd(), "desktop", "main.cjs"), "utf8"); const settings = readFileSync(join(process.cwd(), "app", "AppSettingsPanel.tsx"), "utf8");
  const packageScripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;
  assert.match(packageJson, /prepare:voice/); assert.match(packageJson, /npm run prepare:voice/); assert.ok(packageScripts["package:windows"].includes("node_modules/\\.vite(?:-temp)?")); assert.match(packageJson, /trim-packaged-runtime\.mjs/); assert.match(packageJson, /update-windows-launcher\.ps1/); assert.match(prepare, /whisper-bin-x64\.zip/); assert.match(prepare, /ggml-tiny\.en-q5_1\.bin/); assert.match(prepare, /archiveSha256/); assert.match(prepare, /modelSha1/); assert.match(prepare, /requiredEngineFiles/); assert.match(prepare, /rmSync\(join\(releaseDirectory, entry\.name\)/); assert.match(trim, /\.endsWith\("\.map"\)/); assert.ok(trim.includes("/\\.d\\.(?:ts|cts|mts)$/i")); assert.match(launcher, /VoidCat Harness\.exe/); assert.match(main, /bundledWhisperExecutable/); assert.match(main, /bundledWhisperModel/); assert.match(main, /"-sns"/); assert.match(main, /180_000/); assert.match(settings, /READY OUT OF BOX/); assert.match(settings, /ADVANCED OVERRIDES/);
});

test("active RAG folder scans use the lightweight status route instead of reloading all application state", () => {
  const consoleSource = readFileSync(join(process.cwd(), "app", "VoidCatConsole.tsx"), "utf8"); const backend = readFileSync(join(process.cwd(), "build", "voidcat-local-plugin.ts"), "utf8");
  assert.match(consoleSource, /fetch\("\/api\/rag\/folders\/status"/); assert.match(consoleSource, /setInterval\([^]*1_000/); assert.match(backend, /\/api\/rag\/folders\/status/); assert.match(backend, /listRagFolders\(\)/);
});

test("heavy secondary screens are loaded on demand instead of inflating Unit Bank startup", () => {
  const consoleSource = readFileSync(join(process.cwd(), "app", "VoidCatConsole.tsx"), "utf8");
  assert.match(consoleSource, /const HunterSeekerPanel = lazy\(/); assert.match(consoleSource, /const OsintDirectoryPanel = lazy\(/); assert.match(consoleSource, /const OsintProviderPanel = lazy\(/); assert.match(consoleSource, /<Suspense fallback={<ModuleFallback \/>}>/);
});

test("RSS normalization is deterministic and repeat pulls use the bounded local cache", async () => {
  const source = VOIDCAT_NEWS_SOURCES[0]; const xml = `<?xml version="1.0"?><rss><channel><item><title>Fixture &amp; headline</title><link>https://example.test/story</link><description><![CDATA[<b>Bounded</b> summary]]></description><pubDate>Tue, 28 Jul 2026 12:00:00 GMT</pubDate></item></channel></rss>`;
  const parsed = parseNewsFeed(source, xml, "2026-07-28T13:00:00.000Z"); assert.equal(parsed.length, 1); assert.equal(parsed[0].title, "Fixture & headline"); assert.equal(parsed[0].summary, "Bounded summary");
  let calls = 0; const fetcher = async () => { calls += 1; return new Response(xml, { status: 200, headers: { "Content-Type": "application/rss+xml", ETag: "fixture" } }); };
  const first = await refreshNews([source.id], { fetcher: fetcher as typeof fetch }); const second = await refreshNews([source.id], { fetcher: fetcher as typeof fetch }); assert.equal(calls, 1); assert.equal(first.items[0].id, second.items[0].id); assert.equal(first.externalRequestCount, 1);
});

test("News Watch orders horizontal RSS and OSINT bands before a four-column headline grid", () => {
  const panel = readFileSync(join(process.cwd(), "app", "NewsPanel.tsx"), "utf8"); const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
  assert.ok(panel.indexOf("news-source-band") < panel.indexOf("news-awareness")); assert.ok(panel.indexOf("news-awareness") < panel.indexOf("news-feed-grid")); assert.match(css, /\.news-feed-grid\{[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/); assert.match(css, /\.news-source-band>div,\.news-awareness>div/);
});

test("projects persist across backend restarts and isolate chats, memories, budgets, and tool policy", () => {
  const directory = mkdtempSync(join(tmpdir(), "voidcat-project-test-")); const moduleUrl = pathToFileURL(join(process.cwd(), "build", "voidcat-database.ts")).href; const args = ["--experimental-strip-types", "--input-type=module", "--eval"];
  try {
    const created = execFileSync(process.execPath, [...args, `import * as db from ${JSON.stringify(moduleUrl)}; const p=db.createProject({name:'Case Alpha',chatMemoryLimitBytes:16777216,osintMemoryLimitBytes:33554432}); db.selectProject(p.id); const c=db.createConversation({}); db.addMessage(c.id,'user','alpha-only',[]); db.saveMemory({content:'approved alpha memory'}); db.saveSettings({commandToolNames:['hunter-seeker.feed-health-status','voidcat.news-headlines','invalid.tool']}); process.stdout.write(p.id);`], { cwd: directory, encoding: "utf8" });
    const state = JSON.parse(execFileSync(process.execPath, [...args, `import * as db from ${JSON.stringify(moduleUrl)}; const s=db.getState(); process.stdout.write(JSON.stringify({active:s.activeProject.id,conversations:s.conversations.map(x=>x.preview),memories:s.memories.map(x=>x.content),tools:s.settings.commandToolNames,projects:s.projects.length,archive:db.exportActiveProject()}));`], { cwd: directory, encoding: "utf8" }));
    assert.equal(state.active, created); assert.deepEqual(state.conversations, ["alpha-only"]); assert.deepEqual(state.memories, ["approved alpha memory"]); assert.deepEqual(state.tools, ["hunter-seeker.feed-health-status", "voidcat.news-headlines"]); assert.equal(state.projects, 2); assert.equal(state.archive.format, "voidcat-project");
    const manifest = JSON.parse(readFileSync(join(directory, ".voidcat", "projects", "case-alpha", "project.json"), "utf8")); assert.equal(manifest.id, created);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("persistent UNIT OSINT memories are project-scoped and fail closed at their allotment", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "voidcat-osint-test-")); let store: OsintStore | null = null;
  try { store = new OsintStore({ dataRoot, mode: "synthetic", minimumFreeBytes: 0, writeGuard: async () => ({}) }); await store.initialize(); await store.saveUnitMemory({ id: "unit-memory-1", projectId: "default", toolName: "osint-unit.investigate-domain", summary: { claims: [{ id: "claim-1", evidence: "[EV:one]" }] }, limitBytes: 16_384 }); const usage = store.projectUsage("default"); assert.equal(usage.unitMemories, 1); assert.ok(usage.bytes > 0); await assert.rejects(store.saveUnitMemory({ id: "unit-memory-2", projectId: "default", toolName: "osint-unit.investigate-domain", summary: { content: "x".repeat(20_000) }, limitBytes: usage.bytes + 100 }), (error: unknown) => error instanceof OsintStoreError && error.code === "BUDGET_REJECTED"); }
  finally { store?.close(); rmSync(dataRoot, { recursive: true, force: true }); }
});

test("desktop privacy and distribution paths remain explicit, authenticated, and locally bounded", () => {
  const main = readFileSync(join(process.cwd(), "desktop", "main.cjs"), "utf8"); const backend = readFileSync(join(process.cwd(), "build", "voidcat-local-plugin.ts"), "utf8"); const news = readFileSync(join(process.cwd(), "build", "voidcat-news.ts"), "utf8"); const appSettings = readFileSync(join(process.cwd(), "app", "AppSettingsPanel.tsx"), "utf8");
  assert.match(main, /VOIDCAT_LAN_TOKEN/); assert.match(main, /voidcat:voice:transcribe/); assert.match(main, /25 \* 1024 \*\* 2/); assert.match(main, /spokenSentences/); assert.match(backend, /voidcat_lan=/); assert.match(news, /minimumCadenceMs/); assert.match(backend, /module: "model-download"/); assert.match(backend, /10 \* 1024 \*\* 3/); assert.match(appSettings, /DEFAULT PRIVACY CONTRACT/); assert.match(appSettings, /Only explicit searches, feed pulls/);
});
