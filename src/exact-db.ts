import { readFileSync } from "node:fs";

import Database from "better-sqlite3";

import { getDataPaths } from "./config.js";
import { buildExactIndexText, buildExactManifestBody, normalizeExactText } from "./exact.js";
import type { AppConfig, AttachmentManifest, CatalogEntry } from "./types.js";
import { ensureDir, exists } from "./utils.js";

export interface ExactSearchCandidate {
  docKey: string;
  score: number;
}

export interface ExactIndexClient {
  rebuildExactIndex(readyEntries: CatalogEntry[]): Promise<void>;
  syncExactIndex?(
    readyEntries: CatalogEntry[],
    changes: {
      upserts: CatalogEntry[];
      deleteDocKeys: string[];
    },
  ): Promise<void>;
  searchExactCandidates(query: string, limit: number): Promise<ExactSearchCandidate[]>;
  close(): Promise<void>;
}

export type ExactIndexFactory = (config: AppConfig) => Promise<ExactIndexClient>;

function readManifest(path: string): AttachmentManifest {
  return JSON.parse(readFileSync(path, "utf-8")) as AttachmentManifest;
}

function ensureSchema(db: Database.Database): void {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='exact_fts'",
  ).get();
  if (!tableExists) {
    db.exec("CREATE VIRTUAL TABLE exact_fts USING fts5(docKey, title, body, tokenize='trigram')");
  }
}

function exactIndexIsEmpty(db: Database.Database): boolean {
  return !db.prepare("SELECT 1 FROM exact_fts LIMIT 1").get();
}

function indexEntry(
  db: Database.Database,
  entry: CatalogEntry,
): void {
  if (!entry.manifestPath || !exists(entry.manifestPath)) return;
  const manifest = readManifest(entry.manifestPath);
  const title = buildExactIndexText([entry.title]);
  const body = buildExactManifestBody(manifest);
  db.prepare("INSERT INTO exact_fts (docKey, title, body) VALUES (?, ?, ?)").run(
    entry.docKey,
    title,
    body,
  );
}

function rebuildExactIndexRows(db: Database.Database, readyEntries: CatalogEntry[]): void {
  db.exec("DELETE FROM exact_fts");
  for (const entry of readyEntries) {
    indexEntry(db, entry);
  }
}

export async function openExactIndex(config: AppConfig): Promise<ExactIndexClient> {
  const paths = getDataPaths(config.dataDir);
  ensureDir(paths.indexDir);
  const db = new Database(paths.exactDbPath);
  db.pragma("journal_mode = WAL");
  ensureSchema(db);

  return {
    rebuildExactIndex: async (readyEntries) => {
      const tx = db.transaction(() => {
        rebuildExactIndexRows(db, readyEntries);
      });
      tx();
    },

    syncExactIndex: async (readyEntries, changes) => {
      if (readyEntries.length > 0 && exactIndexIsEmpty(db)) {
        const tx = db.transaction(() => {
          rebuildExactIndexRows(db, readyEntries);
        });
        tx();
        return;
      }

      if (changes.upserts.length === 0 && changes.deleteDocKeys.length === 0) {
        return;
      }

      const tx = db.transaction(() => {
        const deleteDocKeys = new Set(changes.deleteDocKeys);
        for (const entry of changes.upserts) {
          deleteDocKeys.add(entry.docKey);
        }
        const deleteStmt = db.prepare("DELETE FROM exact_fts WHERE docKey = ?");
        for (const docKey of deleteDocKeys) {
          deleteStmt.run(docKey);
        }
        for (const entry of changes.upserts) {
          indexEntry(db, entry);
        }
      });
      tx();
    },

    searchExactCandidates: async (query, limit) => {
      const normalizedQuery = normalizeExactText(query);
      if (normalizedQuery.length === 0) {
        throw new Error("Exact search text cannot be empty.");
      }

      // FTS5 trigram requires queries of at least 3 characters.
      // For shorter queries, fall back to scanning the FTS5 content table with LIKE.
      if (normalizedQuery.length < 3) {
        const likePattern = `%${normalizedQuery.replace(/%/gu, "\\%").replace(/_/gu, "\\_")}%`;
        const rows = db
          .prepare(
            `SELECT c0 AS docKey FROM exact_fts_content WHERE c1 LIKE ? ESCAPE '\\' OR c2 LIKE ? ESCAPE '\\' LIMIT ?`,
          )
          .all(likePattern, likePattern, limit) as Array<{ docKey: string }>;
        return rows.map((row, i) => ({ docKey: row.docKey, score: rows.length - i }));
      }

      const escaped = normalizedQuery.replace(/"/gu, '""');
      const rows = db
        .prepare(
          `SELECT docKey, rank FROM exact_fts WHERE exact_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(`"${escaped}"`, limit) as Array<{ docKey: string; rank: number }>;

      return rows.map((row) => ({
        docKey: row.docKey,
        score: -row.rank,
      }));
    },

    close: async () => {
      db.close();
    },
  };
}
