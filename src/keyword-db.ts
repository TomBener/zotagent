import Database from "better-sqlite3";

import { getDataPaths } from "./config.js";
import type { AppConfig, CatalogEntry } from "./types.js";
import { ensureDir, exists, readManifestFile } from "./utils.js";
import { toSimplified } from "./zh-convert.js";

export interface KeywordSearchResult {
  docKey: string;
  blockIndex: number;
  score: number;
}

export interface KeywordBlockSearchResult {
  docKey: string;
  blockIndex: number;
  score: number;
}

export interface KeywordSearchOptions {
  docKeys?: string[];
}

export interface KeywordBlockSearchOptions {
  docKeys?: string[];
}

export interface KeywordIndexClient {
  rebuildIndex(readyEntries: CatalogEntry[]): Promise<void>;
  searchDocs(query: string, limit: number, options?: KeywordSearchOptions): Promise<KeywordSearchResult[]>;
  searchBlocks(query: string, limit: number, options?: KeywordBlockSearchOptions): Promise<KeywordBlockSearchResult[]>;
  isEmpty(): Promise<boolean>;
  close(): Promise<void>;
}

export type KeywordIndexFactory = (config: AppConfig) => Promise<KeywordIndexClient>;
export const KEYWORD_INDEX_SCHEMA_VERSION = "keyword-fts5-porter-unicode61-contentless-tradsimp-v5-rowid-encoded";

// Pack (docId, blockIndex) into the FTS5 rowid: docId * 2^24 + blockIndex.
// 24 bits for blockIndex covers the largest doc observed in the wild
// (~134k blocks) with margin to ~16M; the high bits hold docId, indexed via
// keyword_doc_lookup. SQLite rowids are 64-bit signed, so the upper 39 bits
// give docId effectively unbounded headroom.
const BLOCK_INDEX_BITS = 24;
const BLOCK_INDEX_MAX = (1 << BLOCK_INDEX_BITS) - 1;
const DOC_ID_MULTIPLIER = 1 << BLOCK_INDEX_BITS;

export class KeywordQuerySyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeywordQuerySyntaxError";
  }
}

function ensureSchema(db: Database.Database): void {
  // v3-blockindex left behind a doc-level keyword_fts(title, body) and its
  // keyword_docs shadow. v4-blockonly removed those.
  db.exec("DROP TABLE IF EXISTS keyword_fts");
  db.exec("DROP TABLE IF EXISTS keyword_docs");
  // v4 → v5: the per-row (docKey, blockIndex) shadow is replaced by encoding
  // both into the FTS5 rowid; only a tiny docId → docKey lookup remains.
  db.exec("DROP TABLE IF EXISTS keyword_blocks");

  db.exec(`
    CREATE TABLE IF NOT EXISTS keyword_doc_lookup (
      docId INTEGER PRIMARY KEY,
      docKey TEXT NOT NULL UNIQUE
    )
  `);
  const blockFtsExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='keyword_block_fts'",
  ).get();
  if (!blockFtsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE keyword_block_fts USING fts5(
        text,
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

function rebuildTable(db: Database.Database, readyEntries: CatalogEntry[]): void {
  db.exec("DROP TABLE IF EXISTS keyword_block_fts");
  db.exec(`
    CREATE VIRTUAL TABLE keyword_block_fts USING fts5(
      text,
      tokenize='porter unicode61',
      content=''
    )
  `);
  db.exec("DELETE FROM keyword_doc_lookup");

  const insertLookup = db.prepare("INSERT INTO keyword_doc_lookup (docId, docKey) VALUES (?, ?)");
  const insertBlockFts = db.prepare("INSERT INTO keyword_block_fts (rowid, text) VALUES (?, ?)");

  let nextDocId = 1;
  for (const entry of readyEntries) {
    if (!entry.manifestPath || !exists(entry.manifestPath)) continue;
    const manifest = readManifestFile(entry.manifestPath);
    const indexedBlocks = manifest.blocks
      .map((block) => ({ blockIndex: block.blockIndex, indexed: segmentCjk(toSimplified(block.text)) }))
      .filter((b) => b.indexed.length > 0);
    if (indexedBlocks.length === 0) continue;

    const docId = nextDocId++;
    insertLookup.run(docId, entry.docKey);
    for (const b of indexedBlocks) {
      if (b.blockIndex < 0 || b.blockIndex > BLOCK_INDEX_MAX) {
        // Should never happen: blockIndex is a positive int from the manifest
        // pipeline, and 24 bits gives ~16M of headroom. Guard against silent
        // corruption if a future extractor produces extreme values.
        throw new Error(
          `blockIndex ${b.blockIndex} out of 24-bit range for docKey ${entry.docKey}`,
        );
      }
      const rowid = docId * DOC_ID_MULTIPLIER + b.blockIndex;
      insertBlockFts.run(rowid, b.indexed);
    }
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

// After maskQuotedPhrases, each `"..."` literal is replaced by this marker,
// which contains no whitespace, parens, commas, or quotes — so it naturally
// acts as an opaque PHRASE token to downstream regexes without needing a
// dedicated alternative in their patterns.
const QUOTE_MARK_RE = /^\uE000Q\d+\uE001$/u;
const QUOTE_UNMASK_RE = /\uE000Q(\d+)\uE001/gu;

/**
 * Replace every `"..."` substring with an opaque sentinel token so that
 * regex passes run on the raw query ignore operators embedded inside
 * quoted phrases (e.g. the word NEAR inside `"foo NEAR bar"`).
 */
export function maskQuotedPhrases(query: string): { masked: string; phrases: string[] } {
  const phrases: string[] = [];
  const masked = query.replace(/"[^"]*"/gu, (match) => {
    phrases.push(match);
    return `\uE000Q${phrases.length - 1}\uE001`;
  });
  return { masked, phrases };
}

export function unmaskQuotedPhrases(text: string, phrases: string[]): string {
  return text.replace(QUOTE_UNMASK_RE, (_, idx: string) => phrases[Number(idx)]!);
}

const INFIX_NEAR_PHRASE = '[^\\s()",]+';
const INFIX_NEAR_RE = new RegExp(
  `(${INFIX_NEAR_PHRASE})\\s+NEAR/(\\d+)\\s+(${INFIX_NEAR_PHRASE})`,
  "gi",
);
const BARE_INFIX_NEAR_RE = new RegExp(
  `${INFIX_NEAR_PHRASE}\\s+NEAR\\s+${INFIX_NEAR_PHRASE}`,
  "i",
);
const CJK_RUN_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,}/u;

function assertSupportedKeywordQuery(query: string): void {
  const { masked } = maskQuotedPhrases(query);
  if (/\bNEAR\s*\(/iu.test(masked)) {
    throw new KeywordQuerySyntaxError(
      'NEAR(...) is not supported. Use the single proximity form: "<term A>" NEAR/50 "<term B>".',
    );
  }
  if (BARE_INFIX_NEAR_RE.test(masked)) {
    throw new KeywordQuerySyntaxError(
      'Bare NEAR is not supported. Use the single proximity form with an explicit distance: "<term A>" NEAR/50 "<term B>".',
    );
  }
}

export function rewriteInfixNear(query: string): string {
  const { masked, phrases } = maskQuotedPhrases(query);
  const ensureQuoted = (s: string): string => {
    if (QUOTE_MARK_RE.test(s)) return s;  // already a quoted phrase (masked)
    return CJK_RUN_RE.test(s) ? `"${s}"` : s;
  };
  let result = masked;
  let prev: string;
  do {
    prev = result;
    result = result.replace(INFIX_NEAR_RE, (_, a: string, n: string, b: string) =>
      `NEAR(${ensureQuoted(a)} ${ensureQuoted(b)}, ${n})`,
    );
  } while (result !== prev);
  return unmaskQuotedPhrases(result, phrases);
}

export function buildFtsQuery(query: string): string {
  query = toSimplified(query);
  assertSupportedKeywordQuery(query);
  query = rewriteInfixNear(query);
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

// Translate user-supplied docKeys into the docId integers used by the FTS5
// rowid encoding. Returns:
//   - []   when no filter is requested (caller leaves the query unconstrained)
//   - null when the caller specified docKeys but none are indexed (search is
//          guaranteed to return no rows; caller should short-circuit)
//   - [id, ...] otherwise
function resolveDocIds(db: Database.Database, docKeys: string[] | undefined): number[] | null {
  if (!docKeys || docKeys.length === 0) return [];
  const placeholders = docKeys.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT docId FROM keyword_doc_lookup WHERE docKey IN (${placeholders})`,
  ).all(...docKeys) as Array<{ docId: number }>;
  if (rows.length === 0) return null;
  return rows.map((r) => r.docId);
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

    isEmpty: async () => {
      const row = db.prepare("SELECT 1 FROM keyword_doc_lookup LIMIT 1").get();
      return row === undefined;
    },

    searchDocs: async (query, limit, options) => {
      if (query.trim().length === 0) {
        throw new Error("Search text cannot be empty.");
      }
      const docIds = resolveDocIds(db, options?.docKeys);
      if (docIds === null) return [];

      const docIdFilter = docIds.length > 0
        ? `AND (f.rowid >> ${BLOCK_INDEX_BITS}) IN (${docIds.map(() => "?").join(",")})`
        : "";
      // GROUP BY d.docId + MIN(rank): SQLite's bare-column-with-min rule
      // returns f.rowid from the input row that produced the minimum rank,
      // and blockIndex decodes from the low bits.
      const sql = `
        SELECT
          d.docKey,
          (f.rowid & ${BLOCK_INDEX_MAX}) AS blockIndex,
          MIN(f.rank) AS rank
        FROM keyword_block_fts f
        JOIN keyword_doc_lookup d ON d.docId = (f.rowid >> ${BLOCK_INDEX_BITS})
        WHERE keyword_block_fts MATCH ?
        ${docIdFilter}
        GROUP BY d.docId
        ORDER BY rank
        LIMIT ?
      `;

      const ftsQuery = buildFtsQuery(query);
      try {
        const rows = db.prepare(sql).all(ftsQuery, ...docIds, limit) as Array<{ docKey: string; blockIndex: number; rank: number }>;
        return rows.map((row) => ({ docKey: row.docKey, blockIndex: row.blockIndex, score: -row.rank }));
      } catch (error) {
        if (error instanceof KeywordQuerySyntaxError) {
          throw error;
        }
        const sanitized = query.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
        if (sanitized.length === 0) {
          throw new Error("Search text cannot be empty.");
        }
        const fallback = buildFtsQuery(sanitized);
        const rows = db.prepare(sql).all(fallback, ...docIds, limit) as Array<{ docKey: string; blockIndex: number; rank: number }>;
        return rows.map((row) => ({ docKey: row.docKey, blockIndex: row.blockIndex, score: -row.rank }));
      }
    },

    searchBlocks: async (query, limit, options) => {
      if (query.trim().length === 0) {
        throw new Error("Search text cannot be empty.");
      }
      const docIds = resolveDocIds(db, options?.docKeys);
      if (docIds === null) return [];

      const docIdFilter = docIds.length > 0
        ? `AND (f.rowid >> ${BLOCK_INDEX_BITS}) IN (${docIds.map(() => "?").join(",")})`
        : "";
      const sql = `
        SELECT
          d.docKey,
          (f.rowid & ${BLOCK_INDEX_MAX}) AS blockIndex,
          f.rank
        FROM keyword_block_fts f
        JOIN keyword_doc_lookup d ON d.docId = (f.rowid >> ${BLOCK_INDEX_BITS})
        WHERE keyword_block_fts MATCH ?
        ${docIdFilter}
        ORDER BY f.rank
        LIMIT ?
      `;

      const ftsQuery = buildFtsQuery(query);
      try {
        const rows = db.prepare(sql).all(ftsQuery, ...docIds, limit) as Array<{ docKey: string; blockIndex: number; rank: number }>;
        return rows.map((row) => ({ docKey: row.docKey, blockIndex: row.blockIndex, score: -row.rank }));
      } catch (error) {
        if (error instanceof KeywordQuerySyntaxError) {
          throw error;
        }
        const sanitized = query.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
        if (sanitized.length === 0) {
          throw new Error("Search text cannot be empty.");
        }
        const fallback = buildFtsQuery(sanitized);
        const rows = db.prepare(sql).all(fallback, ...docIds, limit) as Array<{ docKey: string; blockIndex: number; rank: number }>;
        return rows.map((row) => ({ docKey: row.docKey, blockIndex: row.blockIndex, score: -row.rank }));
      }
    },

    close: async () => {
      db.close();
    },
  };
}
