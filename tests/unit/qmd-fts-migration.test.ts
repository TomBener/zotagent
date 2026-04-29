import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  createConsistentBackup,
  createNewSchema,
} from "../../scripts/migrate-qmd-fts-contentless.ts";

function createMinimalQmdTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE content (
      hash TEXT PRIMARY KEY,
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE documents (
      id INTEGER PRIMARY KEY,
      collection TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      hash TEXT NOT NULL,
      active INTEGER NOT NULL
    );
  `);
}

test("migrated qmd FTS triggers tolerate deleting inactive tombstones", () => {
  const db = new Database(":memory:");
  createMinimalQmdTables(db);
  createNewSchema(db);

  db.prepare("INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)").run(
    "hash-one",
    "alpha beta gamma",
    "2026-04-29T00:00:00.000Z",
  );
  db.prepare(`
    INSERT INTO documents (id, collection, path, title, hash, active)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(1, "library", "doc.md", "Doc", "hash-one", 1);

  assert.deepEqual(
    db.prepare("SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'alpha'").all(),
    [{ rowid: 1 }],
  );

  db.prepare("UPDATE documents SET active = 0 WHERE id = 1").run();
  assert.deepEqual(
    db.prepare("SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'alpha'").all(),
    [],
  );

  assert.doesNotThrow(() => {
    db.prepare("DELETE FROM documents WHERE active = 0").run();
    db.exec("INSERT INTO documents_fts(documents_fts) VALUES('integrity-check')");
  });
  db.close();
});

test("qmd migration backup includes committed WAL content", () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-qmd-backup-"));
  const dbPath = join(root, "qmd.sqlite");
  const bakPath = join(root, "qmd.sqlite.bak");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");

  db.exec(`
    CREATE TABLE t (value TEXT NOT NULL);
    INSERT INTO t (value) VALUES ('from-wal');
  `);
  assert.equal(existsSync(`${dbPath}-wal`), true);

  createConsistentBackup(db, bakPath);
  db.close();

  const backup = new Database(bakPath, { readonly: true });
  const row = backup.prepare("SELECT value FROM t").get() as { value: string };
  assert.equal(row.value, "from-wal");
  backup.close();
});
