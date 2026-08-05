/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("legacy main databases are backed up, migrated transactionally, and validated on disposable storage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voidcat-main-migration-test-")); const data = path.join(root, ".voidcat", "data"); await fs.mkdir(data, { recursive: true }); const databasePath = path.join(data, "voidcat.db");
  try {
    const legacy = new DatabaseSync(databasePath); legacy.exec(`
      CREATE TABLE profiles(id TEXT PRIMARY KEY,name TEXT NOT NULL,system_prompt TEXT NOT NULL,temperature REAL NOT NULL,max_tokens INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,profile_id TEXT,model_key TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE memories(id TEXT PRIMARY KEY,content TEXT NOT NULL,category TEXT NOT NULL,importance INTEGER NOT NULL,enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE documents(id TEXT PRIMARY KEY,name TEXT NOT NULL,extension TEXT NOT NULL,stored_path TEXT NOT NULL,size_bytes INTEGER NOT NULL,chunk_count INTEGER NOT NULL,enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE document_chunks(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,chunk_index INTEGER NOT NULL,content TEXT NOT NULL,embedding TEXT NOT NULL);
      CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
      INSERT INTO profiles VALUES('legacy','Legacy profile','preserve me',0.5,1024,'2026-01-01','2026-01-01');
    `); legacy.close();
    const moduleUrl = pathToFileURL(path.join(process.cwd(), "build", "voidcat-database.ts")).href;
    execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", `import { getState } from ${JSON.stringify(moduleUrl)}; getState();`], { cwd: root, windowsHide: true, timeout: 30_000 });
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const column = (table: string, name: string) => (migrated.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === name);
      for (const [table, name] of [["messages", "sources_json"], ["profiles", "top_p"], ["profiles", "repeat_penalty"], ["memories", "embedding"], ["conversations", "web_mode"], ["conversations", "project_id"], ["memories", "project_id"]]) assert.equal(column(table, name), true, `${table}.${name}`);
      assert.equal((migrated.prepare("SELECT system_prompt AS prompt FROM profiles WHERE id='legacy'").get() as { prompt: string }).prompt, "preserve me");
      assert.equal((migrated.prepare("SELECT version FROM voidcat_schema_migrations_v1 WHERE singleton=1").get() as { version: number }).version, 2);
      assert.equal(Object.values((migrated.prepare("PRAGMA quick_check(1)").get() ?? {}) as Record<string, unknown>)[0], "ok");
    } finally { migrated.close(); }
    const backups = await fs.readdir(path.join(root, ".voidcat", "backups")); assert.equal(backups.length, 1);
    const backupPath = path.join(root, ".voidcat", "backups", backups[0], "voidcat.db"); const backup = new DatabaseSync(backupPath, { readOnly: true });
    try { assert.equal(Object.values((backup.prepare("PRAGMA quick_check(1)").get() ?? {}) as Record<string, unknown>)[0], "ok"); assert.equal((backup.prepare("SELECT system_prompt AS prompt FROM profiles WHERE id='legacy'").get() as { prompt: string }).prompt, "preserve me"); }
    finally { backup.close(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
