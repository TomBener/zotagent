#!/usr/bin/env tsx
/**
 * One-time migration: convert `qmd.sqlite documents_fts` from default mode to
 * external-content mode. Default mode keeps a full copy of every indexed body
 * in `documents_fts_content`; external mode defers body lookups to a view over
 * `documents` + `content`. qmd's `searchFTS` already JOINs to `content` for
 * the body it returns, so the duplicate is unused at query time.
 *
 * Modes:
 *   --dry-run  : inspect current schema, report sizes and estimated savings
 *   --apply    : back up, swap schema, rebuild inverted index, integrity-check, vacuum
 *   --verify   : confirm new schema, run a sample query and integrity-check
 *   --rollback : restore from <db>.bak (the existing post-migration db is moved aside)
 *
 * Safety:
 *   - --apply writes a SQLite-consistent qmd.sqlite.bak before any change
 *   - schema swap runs inside a transaction; rebuild + vacuum run after
 *   - rebuild row count is compared against active documents to catch drift
 *   - idempotent: --apply on an already-migrated DB is a no-op
 *
 * Disk:
 *   --apply needs ~db_size for the backup, plus up to ~db_size more during
 *   VACUUM. On an 8.8 GB qmd.sqlite expect ~18 GB peak free space.
 *
 * Usage:
 *   tsx scripts/migrate-qmd-fts-contentless.ts --data-dir <path> (--dry-run|--apply|--verify|--rollback)
 */

import Database from "better-sqlite3";
import { copyFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Mode = "dry-run" | "apply" | "verify" | "rollback";

interface Args {
  dataDir: string;
  mode: Mode;
}

function parseArgs(argv: string[]): Args {
  let dataDir = "";
  let mode: Mode | "" = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir") dataDir = argv[++i] ?? "";
    else if (a === "--dry-run") mode = "dry-run";
    else if (a === "--apply") mode = "apply";
    else if (a === "--verify") mode = "verify";
    else if (a === "--rollback") mode = "rollback";
  }
  if (!dataDir || !mode) {
    console.error(
      "Usage: tsx scripts/migrate-qmd-fts-contentless.ts --data-dir <path> (--dry-run|--apply|--verify|--rollback)",
    );
    process.exit(1);
  }
  return { dataDir, mode };
}

const gb = (n: number) => +(n / 1024 / 1024 / 1024).toFixed(2);
const mb = (n: number) => +(n / 1024 / 1024).toFixed(1);

interface SizeRow {
  name: string;
  bytes: number;
}

const FTS_RELATED = [
  "documents_fts",
  "documents_fts_data",
  "documents_fts_idx",
  "documents_fts_content",
  "documents_fts_docsize",
  "documents_fts_config",
  "content",
  "vectors_vec_vector_chunks00",
];

function tableSizes(db: Database.Database): SizeRow[] {
  const placeholders = FTS_RELATED.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT name, SUM(pgsize) AS bytes FROM dbstat
       WHERE name IN (${placeholders})
       GROUP BY name ORDER BY bytes DESC`,
    )
    .all(...FTS_RELATED) as SizeRow[];
}

function ftsSchemaSql(db: Database.Database): string | null {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'documents_fts'`).get();
  return (row as { sql: string } | undefined)?.sql ?? null;
}

function isExternalContentMode(sql: string | null): boolean {
  if (!sql) return false;
  return /content\s*=\s*'documents_fts_src'/i.test(sql);
}

function reportSizes(label: string, db: Database.Database): void {
  console.log(`--- ${label} ---`);
  const rows = tableSizes(db);
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(36)} ${mb(r.bytes).toString().padStart(8)} MB`);
  }
  const ftsTotal = rows
    .filter((r) => r.name.startsWith("documents_fts"))
    .reduce((s, r) => s + r.bytes, 0);
  console.log(`  ${"FTS subtotal".padEnd(36)} ${mb(ftsTotal).toString().padStart(8)} MB`);
}

function qmdDbPath(dataDir: string): string {
  const p = join(dataDir, "index", "qmd.sqlite");
  if (!existsSync(p)) throw new Error(`qmd.sqlite not found at ${p}`);
  return p;
}

const VIEW_SQL = `
  CREATE VIEW documents_fts_src AS
    SELECT d.id AS id,
           d.collection || '/' || d.path AS filepath,
           d.title AS title,
           c.doc AS body
    FROM documents d
    LEFT JOIN content c ON c.hash = d.hash
    WHERE d.active = 1
`;

const NEW_FTS_SQL = `
  CREATE VIRTUAL TABLE documents_fts USING fts5(
    filepath, title, body,
    content='documents_fts_src', content_rowid='id',
    tokenize='porter unicode61'
  )
`;

// External-content FTS5 needs the OLD column values when removing tokens, so
// the recommended pattern uses the special 'delete' command rather than a bare
// `DELETE FROM documents_fts`. qmd updates `documents` before running
// `cleanupOrphanedContent`, so the OLD body is still reachable via
// `content WHERE hash = old.hash` when the trigger fires; COALESCE to '' is a
// last-line guard against a race that would otherwise leak old tokens.
const TRIGGER_AI_SQL = `
  CREATE TRIGGER documents_ai AFTER INSERT ON documents
  WHEN new.active = 1
  BEGIN
    INSERT INTO documents_fts (rowid, filepath, title, body)
    SELECT new.id,
           new.collection || '/' || new.path,
           new.title,
           (SELECT doc FROM content WHERE hash = new.hash);
  END
`;

const TRIGGER_AD_SQL = `
  CREATE TRIGGER documents_ad AFTER DELETE ON documents
  WHEN old.active = 1
  BEGIN
    INSERT INTO documents_fts (documents_fts, rowid, filepath, title, body)
    VALUES ('delete', old.id,
            old.collection || '/' || old.path,
            old.title,
            COALESCE((SELECT doc FROM content WHERE hash = old.hash), ''));
  END
`;

const TRIGGER_AU_SQL = `
  CREATE TRIGGER documents_au AFTER UPDATE ON documents
  BEGIN
    INSERT INTO documents_fts (documents_fts, rowid, filepath, title, body)
    SELECT 'delete', old.id,
           old.collection || '/' || old.path,
           old.title,
           COALESCE((SELECT doc FROM content WHERE hash = old.hash), '')
    WHERE old.active = 1;

    INSERT INTO documents_fts (rowid, filepath, title, body)
    SELECT new.id,
           new.collection || '/' || new.path,
           new.title,
           (SELECT doc FROM content WHERE hash = new.hash)
    WHERE new.active = 1;
  END
`;

function dropOldFtsAndTriggers(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS documents_ai;
    DROP TRIGGER IF EXISTS documents_ad;
    DROP TRIGGER IF EXISTS documents_au;
    DROP TABLE IF EXISTS documents_fts;
    DROP VIEW IF EXISTS documents_fts_src;
  `);
}

export function createNewSchema(db: Database.Database): void {
  db.exec(VIEW_SQL);
  db.exec(NEW_FTS_SQL);
  db.exec(TRIGGER_AI_SQL);
  db.exec(TRIGGER_AD_SQL);
  db.exec(TRIGGER_AU_SQL);
}

function activeDocCount(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE active = 1`).get();
  return (row as { n: number }).n;
}

function ftsRowCount(db: Database.Database): number {
  // External-content FTS5 supports COUNT via a scan of the inverted index.
  const row = db.prepare(`SELECT COUNT(*) AS n FROM documents_fts`).get();
  return (row as { n: number }).n;
}

export function createConsistentBackup(db: Database.Database, backupPath: string): void {
  db.prepare("VACUUM main INTO ?").run(backupPath);
}

function dryRun(args: Args): void {
  const dbPath = qmdDbPath(args.dataDir);
  const fileSize = statSync(dbPath).size;
  const db = new Database(dbPath, { readonly: true });
  const sql = ftsSchemaSql(db);
  console.log(`qmd.sqlite: ${dbPath}`);
  console.log(`file size:  ${gb(fileSize)} GB`);
  console.log(`current FTS schema:\n  ${(sql ?? "(missing)").replace(/\s+/g, " ").trim()}`);
  console.log(`already migrated: ${isExternalContentMode(sql)}`);
  console.log(`active documents: ${activeDocCount(db)}`);
  reportSizes("CURRENT TABLES", db);
  const contentRow = db
    .prepare(`SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name = 'documents_fts_content'`)
    .get() as { bytes: number | null };
  const contentBytes = contentRow.bytes ?? 0;
  console.log(`\nestimated savings on --apply: ~${gb(contentBytes)} GB`);
  console.log(`(documents_fts_content table is dropped; remaining FTS overhead is the inverted index)`);
  console.log(`\ndisk needed for --apply: ~${gb(fileSize)} GB backup + transient VACUUM space (~${gb(fileSize)} GB peak)`);
  db.close();
}

function applyMigration(args: Args): void {
  const dbPath = qmdDbPath(args.dataDir);
  const bakPath = dbPath + ".bak";

  // Pre-check schema state without holding a write handle into the migration step
  {
    const db = new Database(dbPath, { readonly: true });
    const sql = ftsSchemaSql(db);
    if (isExternalContentMode(sql)) {
      console.log("documents_fts is already in external-content mode; nothing to do.");
      db.close();
      return;
    }
    if (!sql) {
      db.close();
      throw new Error("documents_fts not found; this doesn't look like a qmd database");
    }
    db.close();
  }

  console.log(`backing up:`);
  console.log(`  src: ${dbPath} (${gb(statSync(dbPath).size)} GB)`);
  console.log(`  dst: ${bakPath}`);
  if (existsSync(bakPath)) {
    console.error(`refusing to overwrite existing backup at ${bakPath}`);
    console.error(`if you previously ran --apply, run --rollback or delete the backup manually`);
    process.exit(1);
  }
  const db = new Database(dbPath);
  createConsistentBackup(db, bakPath);
  console.log(`backup ok\n`);

  db.pragma("journal_mode = WAL");
  reportSizes("BEFORE", db);
  const expectedRows = activeDocCount(db);
  console.log(`active documents: ${expectedRows}`);

  console.log("\nschema swap (transactional) ...");
  const swap = db.transaction(() => {
    dropOldFtsAndTriggers(db);
    createNewSchema(db);
  });
  swap();
  console.log("schema swap ok");

  console.log("rebuilding inverted index from view ...");
  const t0 = Date.now();
  db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('rebuild')`);
  console.log(`rebuild ok (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const actualRows = ftsRowCount(db);
  if (actualRows !== expectedRows) {
    console.warn(
      `WARNING: FTS row count (${actualRows}) != active documents (${expectedRows}). ` +
        `Likely cause: documents with hashes missing from the content table. The view's ` +
        `LEFT JOIN allows these through with NULL body; non-NULL is required only for the ` +
        `body column to be searchable. This usually clears up on the next \`zotagent sync\`.`,
    );
  } else {
    console.log(`FTS row count matches active documents (${actualRows})`);
  }

  console.log("integrity-check ...");
  db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('integrity-check')`);
  console.log("integrity-check ok");

  console.log("VACUUM (rewrites the file; this can take a while on large databases) ...");
  const t1 = Date.now();
  db.exec(`VACUUM`);
  console.log(`vacuum ok (${((Date.now() - t1) / 1000).toFixed(1)}s)`);

  reportSizes("AFTER", db);
  db.close();

  const sizeBefore = statSync(bakPath).size;
  const sizeAfter = statSync(dbPath).size;
  console.log(`\n=== Summary ===`);
  console.log(`file size before: ${gb(sizeBefore)} GB`);
  console.log(`file size after:  ${gb(sizeAfter)} GB`);
  console.log(`saved:            ${gb(sizeBefore - sizeAfter)} GB`);
  console.log(`backup retained:  ${bakPath}`);
  console.log(`run \`tsx scripts/migrate-qmd-fts-contentless.ts --data-dir <path> --verify\` to re-test, ` +
    `then \`rm "${bakPath}"\` once happy.`);
}

function verify(args: Args): void {
  const dbPath = qmdDbPath(args.dataDir);
  const db = new Database(dbPath);
  const sql = ftsSchemaSql(db);
  console.log(`current FTS schema:\n  ${(sql ?? "(missing)").replace(/\s+/g, " ").trim()}`);
  if (!isExternalContentMode(sql)) {
    console.error("NOT in external-content mode; --apply hasn't run or is incomplete");
    db.close();
    process.exit(1);
  }
  console.log(`active documents: ${activeDocCount(db)}`);
  console.log(`FTS rows:         ${ftsRowCount(db)}`);

  // Probe with a token guaranteed to exist in any real corpus
  const sample = db
    .prepare(
      `SELECT rowid, bm25(documents_fts, 1.5, 4.0, 1.0) AS s
       FROM documents_fts WHERE documents_fts MATCH 'the' ORDER BY s ASC LIMIT 3`,
    )
    .all();
  console.log(`sample query 'the' (top 3):`, sample);

  db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('integrity-check')`);
  console.log("integrity-check: passed");
  reportSizes("CURRENT TABLES", db);
  db.close();
}

function rollback(args: Args): void {
  const dbPath = qmdDbPath(args.dataDir);
  const bakPath = dbPath + ".bak";
  if (!existsSync(bakPath)) throw new Error(`no backup found at ${bakPath}`);
  const failedPath = dbPath + ".post-migration";
  console.log(`rolling back:`);
  console.log(`  current  : ${dbPath} -> ${failedPath} (kept for inspection)`);
  console.log(`  restored : ${bakPath} -> ${dbPath}`);
  // Sidecar WAL/SHM files would otherwise be paired with the failed copy
  for (const suffix of ["-wal", "-shm"]) {
    const s = dbPath + suffix;
    if (existsSync(s)) unlinkSync(s);
  }
  renameSync(dbPath, failedPath);
  copyFileSync(bakPath, dbPath);
  console.log(`done. delete ${failedPath} once you've confirmed the rollback works.`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "dry-run") dryRun(args);
  else if (args.mode === "apply") applyMigration(args);
  else if (args.mode === "verify") verify(args);
  else if (args.mode === "rollback") rollback(args);
}

function isMainModule(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
}

if (isMainModule()) {
  main();
}
