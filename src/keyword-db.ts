import Database from "better-sqlite3";
import { existsSync } from "node:fs";

import { openFsArtifactStore, type ArtifactReader } from "./artifact-store.js";
import { CJK_CLASS_SOURCE, segmentCjk } from "./cjk.js";
import { getDataPaths } from "./config.js";
import type { AppConfig, CatalogEntry } from "./types.js";
import { ensureDir } from "./utils.js";
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
  rebuildIndex(readyEntries: CatalogEntry[]): Promise<{ skippedDocKeys: string[] }>;
  updateIndex(changedEntries: CatalogEntry[], removedDocKeys: string[]): Promise<{ skippedDocKeys: string[] }>;
  // Reclaim freelist pages. After rebuildIndex the FTS5 tables drop and recreate
  // their contents, leaving 25–30% of the file as dead pages — without VACUUM
  // they stick around indefinitely. Skip on the incremental updateIndex path.
  vacuum(): Promise<void>;
  searchDocs(query: string, limit: number, options?: KeywordSearchOptions): Promise<KeywordSearchResult[]>;
  searchBlocks(query: string, limit: number, options?: KeywordBlockSearchOptions): Promise<KeywordBlockSearchResult[]>;
  isEmpty(): Promise<boolean>;
  close(): Promise<void>;
}

export type KeywordIndexFactory = (config: AppConfig) => Promise<KeywordIndexClient>;
export const KEYWORD_INDEX_SCHEMA_VERSION = "keyword-fts5-porter-unicode61-contentless-delete-tradsimp-v7-nfkc";

// The one text fold shared by index time and query time; any asymmetry
// between the two is a silent miss. NFKC runs first so compatibility forms
// (the ﬁ/ﬂ ligatures PDFs are full of, full-width digits and Latin,
// compatibility ideographs) reach opencc as the ordinary characters it
// knows — the same order normalizeExactText uses for the phrase scanner.
//
// Compatibility punctuation is the exception: NFKC would turn full-width
// `，（）：＂＊` and the vertical/small forms into ASCII `, ( ) : " *`, which
// FTS5 reads as query syntax, so `国家，能力` became a syntax error and a
// full-width quote an unintended phrase. unicode61 treats these characters
// as separators, so they become spaces instead: the tokens are identical,
// and only characters the user typed as ASCII act as operators.
const COMPAT_PUNCTUATION_RE =
  /[\u2024-\u2026\u203C\u2047-\u2049\u2100\u2101\u2105\u2106\u2474-\u24B5\u2A74-\u2A76\u3200-\u321E\u3220-\u3243\u33C2\u33D8\uFE10-\uFE19\uFE30-\uFE4F\uFE50-\uFE6B\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]/gu;
const ASCII_PUNCTUATION_RE = /[!-/:-@[-`{-~]/gu;

function foldKeywordText(text: string): string {
  const separated = text.replace(COMPAT_PUNCTUATION_RE, (char) =>
    char.normalize("NFKC").replace(ASCII_PUNCTUATION_RE, " "),
  );
  return toSimplified(separated.normalize("NFKC"));
}

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

function createKeywordBlockFts(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE keyword_block_fts USING fts5(
      text,
      tokenize='porter unicode61',
      content='',
      contentless_delete=1
    )
  `);
}

function hasCurrentFtsSchema(db: Database.Database): boolean {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='keyword_block_fts'",
  ).get() as { sql: string } | undefined;
  if (!row) return false;
  const sql = row.sql.toLowerCase().replace(/\s+/g, "");
  return sql.includes("content=''") && sql.includes("contentless_delete=1");
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
  if (!hasCurrentFtsSchema(db)) {
    db.exec("DROP TABLE IF EXISTS keyword_block_fts");
    db.exec("DELETE FROM keyword_doc_lookup");
    createKeywordBlockFts(db);
  }
}

// The index records which indexer version built it, so a search can tell
// the user when it is reading rows an older fold produced. Written only by a
// full rebuild: an incremental update never changes how rows are folded.
const SCHEMA_VERSION_KEY = "schemaVersion";

function recordSchemaVersion(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS keyword_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT OR REPLACE INTO keyword_meta (key, value) VALUES (?, ?)")
    .run(SCHEMA_VERSION_KEY, KEYWORD_INDEX_SCHEMA_VERSION);
}

/** False when the keyword index on disk was built by a different indexer
 *  version and not rebuilt since (its rows may miss matches the current
 *  query fold expects); true when it is current or does not exist yet.
 *  Opens the file read-only, so checking never writes. */
export function keywordIndexIsCurrent(dataDir: string): boolean {
  const path = getDataPaths(dataDir).keywordDbPath;
  if (!existsSync(path)) return true;
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='keyword_meta'").get();
    if (!hasMeta) return false;
    const row = db.prepare("SELECT value FROM keyword_meta WHERE key = ?").get(SCHEMA_VERSION_KEY) as
      | { value: string }
      | undefined;
    return row?.value === KEYWORD_INDEX_SCHEMA_VERSION;
  } finally {
    db.close();
  }
}

function resetFtsTable(db: Database.Database): void {
  db.exec("DROP TABLE IF EXISTS keyword_block_fts");
  createKeywordBlockFts(db);
}

// Returns the indexable blocks for an entry, or `null` when the manifest file
// exists but cannot be read (corrupt/truncated gzip). `null` means "skip this
// doc but leave its existing rows alone"; `[]` means "no content to index"
// (missing file or empty after segmentation) and is safe to delete on.
function indexedBlocksForEntry(
  reader: ArtifactReader,
  entry: CatalogEntry,
): Array<{ blockIndex: number; indexed: string }> | null {
  const result = reader.readManifest(entry.docKey);
  if (result.status === "missing") return [];
  if (result.status === "unreadable") return null;
  return result.manifest.blocks
    .map((block) => ({ blockIndex: block.blockIndex, indexed: segmentCjk(foldKeywordText(block.text)) }))
    .filter((b) => b.indexed.length > 0);
}

function assertBlockIndexInRange(docKey: string, blockIndex: number): void {
  if (blockIndex < 0 || blockIndex > BLOCK_INDEX_MAX) {
    // Should never happen: blockIndex is a positive int from the manifest
    // pipeline, and 24 bits gives ~16M of headroom. Guard against silent
    // corruption if a future extractor produces extreme values.
    throw new Error(
      `blockIndex ${blockIndex} out of 24-bit range for docKey ${docKey}`,
    );
  }
}

function deleteDocRows(db: Database.Database, docId: number): void {
  db.prepare("DELETE FROM keyword_block_fts WHERE rowid >= ? AND rowid < ?")
    .run(docId * DOC_ID_MULTIPLIER, (docId + 1) * DOC_ID_MULTIPLIER);
}

function deleteDoc(db: Database.Database, docKey: string): void {
  const row = db.prepare("SELECT docId FROM keyword_doc_lookup WHERE docKey = ?")
    .get(docKey) as { docId: number } | undefined;
  if (!row) return;
  deleteDocRows(db, row.docId);
  db.prepare("DELETE FROM keyword_doc_lookup WHERE docId = ?").run(row.docId);
}

function allocateDocId(db: Database.Database): number {
  const row = db.prepare("SELECT COALESCE(MAX(docId), 0) + 1 AS docId FROM keyword_doc_lookup")
    .get() as { docId: number };
  return row.docId;
}

// Returns the docKey when the entry was skipped because its manifest is
// unreadable (existing rows are left in place), otherwise null.
function upsertEntry(db: Database.Database, reader: ArtifactReader, entry: CatalogEntry): string | null {
  const indexedBlocks = indexedBlocksForEntry(reader, entry);
  if (indexedBlocks === null) {
    // Unreadable manifest: keep any existing rows (stale-but-searchable beats
    // silently vanished) and report the skip.
    return entry.docKey;
  }
  if (indexedBlocks.length === 0) {
    deleteDoc(db, entry.docKey);
    return null;
  }

  const existing = db.prepare("SELECT docId FROM keyword_doc_lookup WHERE docKey = ?")
    .get(entry.docKey) as { docId: number } | undefined;
  const docId = existing?.docId ?? allocateDocId(db);
  if (existing) {
    deleteDocRows(db, docId);
  } else {
    db.prepare("INSERT INTO keyword_doc_lookup (docId, docKey) VALUES (?, ?)")
      .run(docId, entry.docKey);
  }

  const insertBlockFts = db.prepare("INSERT INTO keyword_block_fts (rowid, text) VALUES (?, ?)");
  for (const b of indexedBlocks) {
    assertBlockIndexInRange(entry.docKey, b.blockIndex);
    const rowid = docId * DOC_ID_MULTIPLIER + b.blockIndex;
    insertBlockFts.run(rowid, b.indexed);
  }
  return null;
}

// Returns the docKeys skipped because their manifests were unreadable.
function rebuildTable(
  db: Database.Database,
  reader: ArtifactReader,
  readyEntries: CatalogEntry[],
): string[] {
  resetFtsTable(db);
  db.exec("DELETE FROM keyword_doc_lookup");

  const insertLookup = db.prepare("INSERT INTO keyword_doc_lookup (docId, docKey) VALUES (?, ?)");
  const insertBlockFts = db.prepare("INSERT INTO keyword_block_fts (rowid, text) VALUES (?, ?)");

  const skippedDocKeys: string[] = [];
  let nextDocId = 1;
  for (const entry of readyEntries) {
    const indexedBlocks = indexedBlocksForEntry(reader, entry);
    if (indexedBlocks === null) {
      skippedDocKeys.push(entry.docKey);
      continue;
    }
    if (indexedBlocks.length === 0) continue;

    const docId = nextDocId++;
    insertLookup.run(docId, entry.docKey);
    for (const b of indexedBlocks) {
      assertBlockIndexInRange(entry.docKey, b.blockIndex);
      const rowid = docId * DOC_ID_MULTIPLIER + b.blockIndex;
      insertBlockFts.run(rowid, b.indexed);
    }
  }
  recordSchemaVersion(db);
  return skippedDocKeys;
}

// Returns the docKeys skipped because their manifests were unreadable.
function updateTable(
  db: Database.Database,
  reader: ArtifactReader,
  changedEntries: CatalogEntry[],
  removedDocKeys: string[],
): string[] {
  const changedDocKeys = new Set(changedEntries.map((entry) => entry.docKey));
  for (const docKey of new Set(removedDocKeys)) {
    if (!changedDocKeys.has(docKey)) {
      deleteDoc(db, docKey);
    }
  }
  const skippedDocKeys: string[] = [];
  for (const entry of changedEntries) {
    const skipped = upsertEntry(db, reader, entry);
    if (skipped !== null) skippedDocKeys.push(skipped);
  }
  return skippedDocKeys;
}

// The index holds one token per CJK character (segmentCjk), so an unquoted
// word containing CJK must be reassembled into an ordered phrase: FTS5 NEAR
// ignores order, which made 会社 match 社会 and 事故 match 故事. The word is
// the whole glued run of letters and digits, so `1949年` becomes the phrase
// "1949 年" the index holds rather than a bareword no token equals.
// Punctuation and whitespace are not tokens, so line breaks and OCR spacing
// inside a word still match.
const GLUED_CJK_WORD_RE = new RegExp(`[\\p{L}\\p{N}]*${CJK_CLASS_SOURCE}[\\p{L}\\p{N}]*`, "gu");

function cjkWordToPhrase(word: string): string {
  return [...word].length === 1 ? word : `"${segmentCjk(word)}"`;
}

function rewriteUnquotedCjk(text: string): string {
  return text.replace(GLUED_CJK_WORD_RE, (m, offset: number) => {
    const phrase = cjkWordToPhrase(m);
    const before = offset > 0 && text[offset - 1] !== " " ? " " : "";
    const afterIdx = offset + m.length;
    // A trailing `*` stays glued so the phrase keeps its prefix operator.
    const next = text[afterIdx];
    const after = next !== undefined && next !== " " && next !== "*" ? " " : "";
    return `${before}${phrase}${after}`;
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
const CJK_RUN_RE = new RegExp(`${CJK_CLASS_SOURCE}{2,}`, "u");

// A leading "-" reads as "exclude" in web search engines, but FTS5 has no
// such operator; the query used to fall back to punctuation-stripped text,
// silently turning `state -capacity` into a search that requires capacity.
const MINUS_EXCLUSION_RE = /(?:^|\s)-(?=[\p{L}\p{N}\uE000])/u;

function assertSupportedKeywordQuery(query: string): void {
  const { masked } = maskQuotedPhrases(query);
  if (MINUS_EXCLUSION_RE.test(masked)) {
    throw new KeywordQuerySyntaxError(
      'A leading "-" does not exclude a term in keyword search. Put NOT between terms instead, e.g. `state NOT capacity`.',
    );
  }
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
  query = foldKeywordText(query);
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

type MatchRow = { docKey: string; blockIndex: number; rank: number };

// The shapes of FTS5 refusing the query text itself, as opposed to the
// database failing: those must surface as-is, never as a syntax complaint.
const FTS_SYNTAX_ERROR_RE = /fts5: syntax error|unterminated string|no such column|unknown special query/u;

function isFtsSyntaxError(error: unknown): boolean {
  return error instanceof Error && FTS_SYNTAX_ERROR_RE.test(error.message);
}

// Run a MATCH query. When FTS5 rejects the rewritten query, retry once with
// punctuation stripped — stray quotes, parentheses, and colons are the usual
// culprits — and if that is rejected too, report it as a query the user can
// fix rather than an internal error.
function matchRows(
  db: Database.Database,
  sql: string,
  query: string,
  docIds: number[],
  limit: number,
): KeywordSearchResult[] {
  const run = (ftsQuery: string) =>
    (db.prepare(sql).all(ftsQuery, ...docIds, limit) as MatchRow[])
      .map((row) => ({ docKey: row.docKey, blockIndex: row.blockIndex, score: -row.rank }));
  try {
    return run(buildFtsQuery(query));
  } catch (error) {
    if (!isFtsSyntaxError(error)) throw error;
  }
  const sanitized = query.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
  if (sanitized.length === 0) {
    throw new KeywordQuerySyntaxError(
      `The keyword query ${JSON.stringify(query)} has no words to search for, only punctuation.`,
    );
  }
  try {
    return run(buildFtsQuery(sanitized));
  } catch (error) {
    if (!isFtsSyntaxError(error)) throw error;
    throw new KeywordQuerySyntaxError(
      `Could not parse the keyword query ${JSON.stringify(query)}. AND, OR, and NOT must stand between ` +
        `two terms (uppercase); quote a word to search for it literally, e.g. "OR".`,
    );
  }
}

export async function openKeywordIndex(config: AppConfig): Promise<KeywordIndexClient> {
  const paths = getDataPaths(config.dataDir);
  ensureDir(paths.indexDir);
  const reader: ArtifactReader = openFsArtifactStore({
    normalizedDir: paths.normalizedDir,
    manifestsDir: paths.manifestsDir,
  });
  const db = new Database(paths.keywordDbPath);
  db.pragma("journal_mode = WAL");
  ensureSchema(db);

  return {
    rebuildIndex: async (readyEntries) => {
      let skippedDocKeys: string[] = [];
      const tx = db.transaction(() => {
        skippedDocKeys = rebuildTable(db, reader, readyEntries);
      });
      tx();
      return { skippedDocKeys };
    },

    updateIndex: async (changedEntries, removedDocKeys) => {
      let skippedDocKeys: string[] = [];
      const tx = db.transaction(() => {
        skippedDocKeys = updateTable(db, reader, changedEntries, removedDocKeys);
      });
      tx();
      return { skippedDocKeys };
    },

    vacuum: async () => {
      db.exec("VACUUM");
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

      return matchRows(db, sql, query, docIds, limit);
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

      return matchRows(db, sql, query, docIds, limit);
    },

    close: async () => {
      db.close();
    },
  };
}
