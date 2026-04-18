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

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t";
}

export function segmentCjk(text: string): string {
  const chars = [...text];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const isCjk = CJK_RANGE.test(ch);
    if (out.length > 0 && !isWhitespace(ch)) {
      const prev = out[out.length - 1]!;
      if (!isWhitespace(prev)) {
        const prevIsCjk = CJK_RANGE.test(prev);
        if (isCjk || prevIsCjk) {
          out.push(" ");
        }
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

function rewriteUnquotedCjk(text: string): string {
  const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,}/gu;
  return text.replace(CJK_RUN, (m, offset) => {
    const near = cjkRunToNear(m);
    const before = offset > 0 && text[offset - 1] !== " " ? " " : "";
    const afterIdx = offset + m.length;
    const after = afterIdx < text.length && text[afterIdx] !== " " ? " " : "";
    return `${before}${near}${after}`;
  });
}

export function buildFtsQuery(query: string): string {
  const parts: string[] = [];
  let inQuote = false;
  let current = "";
  for (const ch of query) {
    if (ch === '"') {
      if (inQuote) {
        parts.push(`"${segmentCjk(current)}"`);
        current = "";
      } else {
        if (current.trim()) parts.push(rewriteUnquotedCjk(current));
        current = "";
      }
      inQuote = !inQuote;
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    parts.push(inQuote ? `"${segmentCjk(current)}"` : rewriteUnquotedCjk(current));
  }
  return parts.join(" ").replace(/\s{2,}/g, " ").trim();
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
