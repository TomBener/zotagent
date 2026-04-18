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
  search(query: string, limit: number): Promise<KeywordSearchResult[]>;
  close(): Promise<void>;
}

export type KeywordIndexFactory = (config: AppConfig) => Promise<KeywordIndexClient>;

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS keyword_docs (
      rowid INTEGER PRIMARY KEY,
      docKey TEXT NOT NULL
    )
  `);
  const ftsExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='keyword_fts'",
  ).get();
  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE keyword_fts USING fts5(
        title, body,
        tokenize='porter unicode61',
        content=''
      )
    `);
  }
}

const CJK_RANGE =
  /(\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul})/u;

export function segmentCjk(text: string): string {
  const out: string[] = [];
  for (const ch of text) {
    if (out.length > 0 && CJK_RANGE.test(ch)) {
      const prev = out[out.length - 1]!;
      if (prev !== " " && prev !== "\n") {
        out.push(" ");
      }
    }
    out.push(ch);
  }
  return out.join("");
}

function buildBody(entry: CatalogEntry): string | null {
  if (!entry.manifestPath || !exists(entry.manifestPath)) return null;
  const manifest = readManifestFile(entry.manifestPath);
  return manifest.blocks
    .map((block) => block.text)
    .filter((text) => text.length > 0)
    .map((text) => segmentCjk(text))
    .join("\n");
}

function rebuildTable(db: Database.Database, readyEntries: CatalogEntry[]): void {
  db.exec("DROP TABLE IF EXISTS keyword_fts");
  db.exec(`
    CREATE VIRTUAL TABLE keyword_fts USING fts5(
      title, body,
      tokenize='porter unicode61',
      content=''
    )
  `);
  db.exec("DELETE FROM keyword_docs");

  const insertDoc = db.prepare("INSERT INTO keyword_docs (rowid, docKey) VALUES (?, ?)");
  const insertFts = db.prepare("INSERT INTO keyword_fts (rowid, title, body) VALUES (?, ?, ?)");

  let rowid = 1;
  for (const entry of readyEntries) {
    const body = buildBody(entry);
    if (body === null) continue;
    insertDoc.run(rowid, entry.docKey);
    insertFts.run(rowid, segmentCjk(entry.title), body);
    rowid += 1;
  }
}

function cjkRunToNear(run: string): string {
  const chars = [...run];
  if (chars.length === 1) return chars[0]!;
  const distance = Math.max(1, chars.length - 1);
  return `NEAR(${chars.join(" ")}, ${distance})`;
}

export function buildFtsQuery(query: string): string {
  const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,}/gu;
  return query.replace(CJK_RUN, (match) => cjkRunToNear(match));
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
        rebuildTable(db, readyEntries);
      });
      tx();
    },

    search: async (query, limit) => {
      if (query.trim().length === 0) {
        throw new Error("Search text cannot be empty.");
      }

      const sql = `
        SELECT d.docKey, f.rank
        FROM keyword_fts f
        JOIN keyword_docs d ON d.rowid = f.rowid
        WHERE keyword_fts MATCH ?
        ORDER BY f.rank
        LIMIT ?
      `;

      const ftsQuery = buildFtsQuery(query);
      try {
        const rows = db.prepare(sql).all(ftsQuery, limit) as Array<{ docKey: string; rank: number }>;
        return rows.map((row) => ({ docKey: row.docKey, score: -row.rank }));
      } catch {
        const sanitized = query.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
        if (sanitized.length === 0) {
          throw new Error("Search text cannot be empty.");
        }
        const fallback = buildFtsQuery(sanitized);
        const rows = db.prepare(sql).all(fallback, limit) as Array<{ docKey: string; rank: number }>;
        return rows.map((row) => ({ docKey: row.docKey, score: -row.rank }));
      }
    },

    close: async () => {
      db.close();
    },
  };
}
