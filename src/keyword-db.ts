import Database from "better-sqlite3";

import { getDataPaths } from "./config.js";
import type { AppConfig, CatalogEntry } from "./types.js";
import { ensureDir, exists, readManifestFile } from "./utils.js";

export interface KeywordSearchResult {
  docKey: string;
  score: number;
}

export interface KeywordIndexClient {
  rebuildIndex(readyEntries: CatalogEntry[]): Promise<void>;
  syncIndex?(
    readyEntries: CatalogEntry[],
    changes: {
      upserts: CatalogEntry[];
      deleteDocKeys: string[];
    },
  ): Promise<void>;
  search(query: string, limit: number): Promise<KeywordSearchResult[]>;
  close(): Promise<void>;
}

export type KeywordIndexFactory = (config: AppConfig) => Promise<KeywordIndexClient>;

function ensureSchema(db: Database.Database): void {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='keyword_fts'",
  ).get();
  if (!tableExists) {
    db.exec(
      "CREATE VIRTUAL TABLE keyword_fts USING fts5(docKey UNINDEXED, title, body, tokenize='porter unicode61')",
    );
  }
}

function indexIsEmpty(db: Database.Database): boolean {
  return !db.prepare("SELECT 1 FROM keyword_fts LIMIT 1").get();
}

function buildBody(entry: CatalogEntry): string | null {
  if (!entry.manifestPath || !exists(entry.manifestPath)) return null;
  const manifest = readManifestFile(entry.manifestPath);
  return manifest.blocks
    .map((block) => block.text)
    .filter((text) => text.length > 0)
    .join("\n");
}

function indexEntry(db: Database.Database, entry: CatalogEntry): void {
  const body = buildBody(entry);
  if (body === null) return;
  db.prepare("INSERT INTO keyword_fts (docKey, title, body) VALUES (?, ?, ?)").run(
    entry.docKey,
    entry.title,
    body,
  );
}

function rebuildRows(db: Database.Database, readyEntries: CatalogEntry[]): void {
  db.exec("DELETE FROM keyword_fts");
  for (const entry of readyEntries) {
    indexEntry(db, entry);
  }
}

export async function openKeywordIndex(config: AppConfig): Promise<KeywordIndexClient> {
  const paths = getDataPaths(config.dataDir);
  ensureDir(paths.indexDir);
  const db = new Database(paths.keywordDbPath);
  db.pragma("journal_mode = WAL");
  ensureSchema(db);

  return {
    rebuildIndex: async (readyEntries) => {
      const tx = db.transaction(() => {
        rebuildRows(db, readyEntries);
      });
      tx();
    },

    syncIndex: async (readyEntries, changes) => {
      if (readyEntries.length > 0 && indexIsEmpty(db)) {
        const tx = db.transaction(() => {
          rebuildRows(db, readyEntries);
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
        const deleteStmt = db.prepare("DELETE FROM keyword_fts WHERE docKey = ?");
        for (const docKey of deleteDocKeys) {
          deleteStmt.run(docKey);
        }
        for (const entry of changes.upserts) {
          indexEntry(db, entry);
        }
      });
      tx();
    },

    search: async (query, limit) => {
      if (query.trim().length === 0) {
        throw new Error("Search text cannot be empty.");
      }

      try {
        const rows = db
          .prepare(
            "SELECT docKey, rank FROM keyword_fts WHERE keyword_fts MATCH ? ORDER BY rank LIMIT ?",
          )
          .all(query, limit) as Array<{ docKey: string; rank: number }>;

        return rows.map((row) => ({
          docKey: row.docKey,
          score: -row.rank, // FTS5 rank is negative; negate for natural ordering
        }));
      } catch (error: unknown) {
        // FTS5 throws on malformed queries (unbalanced quotes, bad operators).
        // Retry as a simple phrase search with special characters stripped.
        const sanitized = query.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
        if (sanitized.length === 0) {
          throw new Error("Search text cannot be empty.");
        }
        const rows = db
          .prepare(
            "SELECT docKey, rank FROM keyword_fts WHERE keyword_fts MATCH ? ORDER BY rank LIMIT ?",
          )
          .all(sanitized, limit) as Array<{ docKey: string; rank: number }>;

        return rows.map((row) => ({
          docKey: row.docKey,
          score: -row.rank,
        }));
      }
    },

    close: async () => {
      db.close();
    },
  };
}
