import { readFileSync } from "node:fs";
import { basename as pathBasename } from "node:path";

import { getEncoding, type Tiktoken } from "js-tiktoken";

import { getDataPaths, resolveConfig, type ConfigOverrides } from "./config.js";
import { findExactPhraseBlockRange, normalizeExactText } from "./exact.js";
import { isBoilerplateLikeText, isTableOfContentsLikeText } from "./heuristics.js";
import { maskQuotedPhrases, openKeywordIndex, unmaskQuotedPhrases, type KeywordIndexFactory } from "./keyword-db.js";
import { mergeManifestsForItem } from "./manifest.js";
import { openQmdClient, type QmdFactory } from "./qmd.js";
import { getReadyEntries, readCatalogFile, summarizeCatalog } from "./state.js";
import type { AttachmentManifest, CatalogEntry, ManifestBlock, SearchResultRow } from "./types.js";
import { cleanText, compactHomePath, exists, overlap, readManifestFile } from "./utils.js";
import { toSimplified } from "./zh-convert.js";

interface SearchBehaviorOptions {
  semantic?: boolean;
  minScore?: number;
  progress?: (message: string) => void;
  itemKeys?: string[];
}

const ITEM_KEY_RE = /^[A-Z0-9]{8}$/;

// Resolve the --key argument to a Zotero itemKey. citationKey lookups
// translate to itemKey first so downstream fetching can grab *every*
// ready attachment for that item, even if citationKey is missing or
// stale on some entries (e.g. a partial re-sync).
function resolveKeyToItemKey(key: string, entries: CatalogEntry[]): string {
  if (ITEM_KEY_RE.test(key)) return key;
  const matches = entries.filter((entry) => entry.citationKey === key);
  if (matches.length === 0) {
    throw new Error(`No indexed attachment found for citationKey: ${key}`);
  }
  const itemKeys = new Set(matches.map((entry) => entry.itemKey));
  if (itemKeys.size > 1) {
    throw new Error(
      `Multiple items share citationKey "${key}": itemKeys = ${[...itemKeys].sort().join(", ")}`,
    );
  }
  return itemKeys.values().next().value as string;
}

function resolveReadyEntries(key: string, entries: CatalogEntry[]): CatalogEntry[] {
  if (!key) {
    throw new Error("Provide --key <key>.");
  }
  const itemKey = resolveKeyToItemKey(key, entries);
  const matched = entries
    .filter((entry) => entry.itemKey === itemKey)
    .sort((a, b) => a.filePath.localeCompare(b.filePath));
  if (matched.length === 0) {
    throw new Error(`No indexed attachment found for itemKey: ${itemKey}`);
  }
  return matched;
}

function groupReadyEntriesByItemKey(entries: CatalogEntry[]): Map<string, CatalogEntry[]> {
  const groups = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.itemKey);
    if (list) {
      list.push(entry);
    } else {
      groups.set(entry.itemKey, [entry]);
    }
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.filePath.localeCompare(b.filePath));
  }
  return groups;
}

function readManifestCached(
  entry: CatalogEntry,
  cache: Map<string, AttachmentManifest>,
): AttachmentManifest {
  const cached = cache.get(entry.docKey);
  if (cached) return cached;
  if (!entry.manifestPath || !exists(entry.manifestPath)) {
    throw new Error(`Indexed manifest not found for file: ${entry.filePath}`);
  }
  const manifest = readManifestFile(entry.manifestPath);
  cache.set(entry.docKey, manifest);
  return manifest;
}

function attachmentGlobalOffset(
  entry: CatalogEntry,
  itemGroup: CatalogEntry[],
  cache: Map<string, AttachmentManifest>,
): number {
  if (itemGroup.length <= 1) return 0;
  const idx = itemGroup.findIndex((e) => e.docKey === entry.docKey);
  if (idx <= 0) return 0;
  let offset = 0;
  for (let i = 0; i < idx; i += 1) {
    const sibling = itemGroup[i]!;
    const manifest = readManifestCached(sibling, cache);
    offset += manifest.blocks.length + 1;
  }
  return offset;
}

function loadMergedManifestForGroup(
  itemGroup: CatalogEntry[],
  cache: Map<string, AttachmentManifest>,
): AttachmentManifest {
  if (itemGroup.length === 1) {
    return readManifestCached(itemGroup[0]!, cache);
  }
  const manifests = itemGroup.map((entry) => readManifestCached(entry, cache));
  return mergeManifestsForItem(manifests);
}

function itemFilePaths(itemGroup: CatalogEntry[]): string[] {
  return itemGroup.map((entry) => compactHomePath(entry.filePath));
}

export function mapChunkToBlockRange(
  manifest: AttachmentManifest,
  chunkPos: number,
  chunkText: string,
): { blockStart: number; blockEnd: number } {
  if (manifest.blocks.length === 0) {
    return { blockStart: 0, blockEnd: 0 };
  }

  const start = Math.max(0, chunkPos);
  const end = start + Math.max(1, chunkText.length);
  const overlappingBlocks = manifest.blocks.filter((block) =>
    overlap(block.charStart, block.charEnd, start, end),
  );

  if (overlappingBlocks.length > 0) {
    return {
      blockStart: overlappingBlocks[0]!.blockIndex,
      blockEnd: overlappingBlocks[overlappingBlocks.length - 1]!.blockIndex,
    };
  }

  const containing = manifest.blocks.find((block) => block.charStart <= start && start < block.charEnd);
  if (containing) {
    return { blockStart: containing.blockIndex, blockEnd: containing.blockIndex };
  }

  let nearest = manifest.blocks[0]!;
  let nearestDistance = Math.abs(start - nearest.charStart);
  for (const block of manifest.blocks) {
    const distance = Math.min(Math.abs(start - block.charStart), Math.abs(start - block.charEnd));
    if (distance < nearestDistance) {
      nearest = block;
      nearestDistance = distance;
    }
  }

  return { blockStart: nearest.blockIndex, blockEnd: nearest.blockIndex };
}

const SEARCH_PASSAGE_MAX_TOKENS = 500;

let passageEncoder: Tiktoken | undefined;
function getPassageEncoder(): Tiktoken {
  if (!passageEncoder) passageEncoder = getEncoding("o200k_base");
  return passageEncoder;
}

// Token-based cap keeps the agent-context cost roughly language-neutral:
// 500 chars of English is ~125 tokens, 500 chars of Chinese is ~500+ tokens.
// o200k_base (GPT-4o) is used as a close proxy for Claude's tokenizer, since
// Anthropic does not publish an offline tokenizer for Claude 3+.
function truncateSearchPassage(text: string): string {
  const enc = getPassageEncoder();
  const tokens = enc.encode(text);
  if (tokens.length <= SEARCH_PASSAGE_MAX_TOKENS) return text;
  return enc.decode(tokens.slice(0, SEARCH_PASSAGE_MAX_TOKENS)) + "…";
}

// Half-window for the search-result passage, in characters of the rendered
// markdown. Combined with truncateSearchPassage's token cap, this gives the
// agent a continuous slice centered on the hit that fits within ~500 tokens
// for English and ~250 chars worth of content for CJK.
const PASSAGE_CHAR_RADIUS = 250;

type SearchHitRange = {
  blockStart: number;
  blockEnd: number;
  // Per-attachment character offset in the rendered markdown. buildSearchRow
  // translates this into the item-global merged document coordinate.
  anchorOffset?: number;
};

type QueryAnchorCandidate = {
  text: string;
  prefix: boolean;
  priority: number;
};

const QUOTE_MARK_RE = /\uE000Q\d+\uE001/gu;
const NEGATED_QUOTE_MARK_RE = /\bNOT\s+\uE000Q(\d+)\uE001/giu;
const SEARCH_OPERATOR_RE = /^(AND|OR|NOT|NEAR)$/iu;
const SEARCH_OPERATOR_IN_QUERY_RE = /\b(?:AND|OR|NOT|NEAR(?:\/\d+)?)\b/iu;
const CJK_CHAR_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function cleanCandidatePhrase(text: string): string {
  return cleanText(text)
    .replace(/\s+/gu, " ")
    .trim();
}

function addQueryAnchorCandidate(
  candidates: QueryAnchorCandidate[],
  text: string,
  priority: number,
  prefix = false,
): void {
  const cleaned = cleanCandidatePhrase(text);
  if (!cleaned) return;
  candidates.push({ text: cleaned, priority, prefix });
}

function queryAnchorCandidates(query: string): QueryAnchorCandidate[] {
  const { masked, phrases } = maskQuotedPhrases(query);
  const candidates: QueryAnchorCandidate[] = [];
  const negatedPhraseIndexes = new Set<number>();

  let negatedPhrase: RegExpExecArray | null;
  while ((negatedPhrase = NEGATED_QUOTE_MARK_RE.exec(masked)) !== null) {
    negatedPhraseIndexes.add(Number(negatedPhrase[1]));
  }

  for (const [index, phrase] of phrases.entries()) {
    if (negatedPhraseIndexes.has(index)) continue;
    addQueryAnchorCandidate(candidates, phrase.slice(1, -1), 0);
  }

  // For simple unquoted multi-token queries, try the literal phrase before
  // falling back to individual terms. Operator queries (`OR`, `NOT`, `NEAR/N`)
  // are intentionally term-anchored because the whole query is not a literal.
  const hasOperators = SEARCH_OPERATOR_IN_QUERY_RE.test(masked);
  if (!hasOperators && phrases.length === 0) {
    const literal = query
      .replace(/[^\p{L}\p{N}*]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (literal.includes(" ") || CJK_CHAR_RE.test(literal)) {
      addQueryAnchorCandidate(candidates, literal, 1);
    }
  }

  const unquoted = masked
    .replace(/\bNOT\s+(?:\uE000Q\d+\uE001|[\p{L}\p{N}]+\*?)/giu, " ")
    .replace(QUOTE_MARK_RE, " ")
    .replace(/\bNEAR\/\d+\b/giu, " ");
  const tokens = unquoted.match(/[\p{L}\p{N}]+\*?/gu) ?? [];
  for (const token of tokens) {
    const prefix = token.endsWith("*");
    const text = prefix ? token.slice(0, -1) : token;
    if (!text || SEARCH_OPERATOR_RE.test(text) || /^\d+$/u.test(text)) continue;
    addQueryAnchorCandidate(candidates, text, 2, prefix);
  }

  const seen = new Set<string>();
  return candidates
    .sort((a, b) => a.priority - b.priority || b.text.length - a.text.length)
    .filter((candidate) => {
      const key = `${candidate.priority}:${candidate.prefix}:${candidate.text.toLocaleLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function candidatePattern(candidate: QueryAnchorCandidate): RegExp | null {
  const chars = [...candidate.text.normalize("NFKC")];
  if (chars.length === 0) return null;

  let pattern = "";
  let containsCjk = false;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (/\s/u.test(ch)) {
      pattern += "\\s+";
      while (/\s/u.test(chars[i + 1] ?? "")) i += 1;
      continue;
    }
    containsCjk ||= CJK_CHAR_RE.test(ch);
    pattern += escapeRegExp(ch);
    const next = chars[i + 1];
    if (CJK_CHAR_RE.test(ch) && next !== undefined && CJK_CHAR_RE.test(next)) {
      pattern += "\\s*";
    }
  }

  const before = containsCjk ? "" : "(?<![\\p{L}\\p{N}])";
  const after = containsCjk || candidate.prefix ? "" : "(?![\\p{L}\\p{N}])";
  const suffix = candidate.prefix && !containsCjk ? "[\\p{L}\\p{N}]*" : "";
  return new RegExp(`${before}${pattern}${suffix}${after}`, "iu");
}

function findCandidateMatch(
  text: string,
  candidate: QueryAnchorCandidate,
): { index: number; length: number } | undefined {
  const directPattern = candidatePattern(candidate);
  const direct = directPattern?.exec(text);
  if (direct) return { index: direct.index, length: direct[0].length };

  const simplifiedText = toSimplified(text.normalize("NFKC"));
  const simplifiedCandidate = {
    ...candidate,
    text: toSimplified(candidate.text.normalize("NFKC")),
  };
  if (simplifiedText === text && simplifiedCandidate.text === candidate.text) return undefined;

  const simplifiedPattern = candidatePattern(simplifiedCandidate);
  const simplified = simplifiedPattern?.exec(simplifiedText);
  if (!simplified) return undefined;
  // OpenCC and NFKC usually preserve offsets for the CJK and ASCII cases this
  // fallback serves. If not, the clamped index is still a closer anchor than
  // the whole-block midpoint.
  return {
    index: Math.min(simplified.index, text.length),
    length: simplified[0].length,
  };
}

function renderManifestRangeWithOffsets(
  manifest: AttachmentManifest,
  range: { blockStart: number; blockEnd: number },
): { text: string; offsets: number[] } {
  let text = "";
  const offsets: number[] = [];
  let lastOffset = 0;

  for (let i = range.blockStart; i <= range.blockEnd; i += 1) {
    const block = manifest.blocks[i];
    if (!block) continue;
    if (text.length > 0) {
      text += "\n\n";
      offsets.push(lastOffset, lastOffset);
    }
    const blockText = cleanText(block.text);
    const snippet = renderMarkdownBlock({ ...block, text: blockText }).trim();
    for (let j = 0; j < snippet.length; j += 1) {
      offsets.push(block.charStart + j);
    }
    text += snippet;
    lastOffset = block.charEnd;
  }

  return { text, offsets };
}

function findQueryAnchorOffset(
  manifest: AttachmentManifest,
  range: { blockStart: number; blockEnd: number },
  query: string | undefined,
): number | undefined {
  if (!query?.trim()) return undefined;
  const candidates = queryAnchorCandidates(query);
  if (candidates.length === 0) return undefined;

  const rendered = renderManifestRangeWithOffsets(manifest, range);
  if (rendered.text.length === 0) return undefined;

  for (const candidate of candidates) {
    const match = findCandidateMatch(rendered.text, candidate);
    if (!match) continue;
    const anchorIndex = Math.min(
      rendered.offsets.length - 1,
      match.index + Math.floor(Math.max(1, match.length) / 2),
    );
    return rendered.offsets[anchorIndex];
  }
  return undefined;
}

function buildSearchRow(
  entry: CatalogEntry,
  itemGroup: CatalogEntry[],
  manifestCache: Map<string, AttachmentManifest>,
  markdownCache: Map<string, string>,
  hitRange: SearchHitRange,
  score: number,
  query?: string,
): SearchResultRow {
  // The FTS hit is per-attachment; everything user-facing is item-global. Load
  // the merged manifest once per item and slice its rendered markdown around
  // the hit so passages read as continuous prose, not as paragraph fragments
  // joined with `\n\n`.
  const merged = loadMergedManifestForGroup(itemGroup, manifestCache);
  const source = readManifestCached(entry, manifestCache);
  const blockOffset = attachmentGlobalOffset(entry, itemGroup, manifestCache);
  const mergedStart = hitRange.blockStart + blockOffset;
  const mergedEnd = hitRange.blockEnd + blockOffset;
  const sourceStartBlock = source.blocks[hitRange.blockStart];
  const sourceEndBlock = source.blocks[hitRange.blockEnd];
  const startBlock = merged.blocks[mergedStart];
  const endBlock = merged.blocks[mergedEnd];
  if (!sourceStartBlock || !sourceEndBlock || !startBlock || !endBlock) {
    throw new Error(
      `Hit block out of range for ${entry.itemKey}: requested ${mergedStart}..${mergedEnd}, manifest has ${merged.blocks.length} blocks`,
    );
  }
  let markdown = markdownCache.get(entry.itemKey);
  if (markdown === undefined) {
    markdown = renderManifestMarkdown(merged);
    markdownCache.set(entry.itemKey, markdown);
  }
  const sourceFallbackAnchor = Math.round((sourceStartBlock.charStart + sourceEndBlock.charEnd) / 2);
  const sourceAnchor = hitRange.anchorOffset
    ?? findQueryAnchorOffset(source, hitRange, query)
    ?? sourceFallbackAnchor;
  const charShift = startBlock.charStart - sourceStartBlock.charStart;
  const spanCenter = Math.max(0, Math.min(markdown.length, sourceAnchor + charShift));
  const passageStart = Math.max(0, spanCenter - PASSAGE_CHAR_RADIUS);
  const passageEnd = Math.min(markdown.length, spanCenter + PASSAGE_CHAR_RADIUS);
  let passage = markdown.slice(passageStart, passageEnd);
  if (passageStart > 0) passage = "…" + passage;
  if (passageEnd < markdown.length) passage = passage + "…";

  return {
    itemKey: entry.itemKey,
    title: entry.title,
    authors: entry.authors,
    ...(entry.year ? { year: entry.year } : {}),
    passage: truncateSearchPassage(passage),
    charOffset: spanCenter,
    ...(startBlock.pageStart !== undefined ? { pageStart: startBlock.pageStart } : {}),
    ...(endBlock.pageEnd !== undefined ? { pageEnd: endBlock.pageEnd } : {}),
    score: Math.round(score * 10000) / 10000,
  };
}

/**
 * If the query is a single quoted multi-token phrase (e.g. `"Ho, Peter. 2017"`)
 * with no operators or other content outside the quotes, return the inner
 * phrase text; otherwise null. Used to gate the supplemental cross-block
 * phrase scan in search-in: any other query shape is FTS5's responsibility,
 * and stripping operators to manufacture a substring would resurface blocks
 * FTS5 legitimately excluded (e.g. `alpha NOT beta`). Single-token non-CJK
 * quoted queries are skipped because per-block FTS already finds every
 * occurrence of a single token, and substring matching on a short token
 * would falsely "hit" prefixes of unrelated words like `how` for `ho`.
 */
function singleQuotedPhrase(query: string): string | null {
  const { masked, phrases } = maskQuotedPhrases(query);
  if (phrases.length !== 1) return null;
  const remainder = masked.replace(/\uE000Q\d+\uE001/gu, "").trim();
  if (remainder.length > 0) return null;
  const inner = phrases[0]!.slice(1, -1);
  if (!isMultiTokenExactPhrase(inner)) return null;
  return inner;
}

function isMultiTokenExactPhrase(phrase: string): boolean {
  const normalized = normalizeExactText(phrase);
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length >= 2) return true;

  // CJK phrases normalize to one contiguous token, but a multi-character CJK
  // string is still a real phrase for the cross-block exact scanner.
  const compact = normalized.replace(/\s+/gu, "");
  return CJK_CHAR_RE.test(compact) && [...compact].length >= 2;
}

function buildKeywordSearchRow(
  entry: CatalogEntry,
  itemGroup: CatalogEntry[],
  manifestCache: Map<string, AttachmentManifest>,
  markdownCache: Map<string, string>,
  blockIndex: number,
  score: number,
  query: string,
): SearchResultRow {
  // FTS5 already returned this doc's best matching block; just frame the
  // single-block range. Block-level FTS does not match phrases that wrap a
  // block boundary — that gap is left to `search-in` (which has a manifest-
  // level cross-block scan), since scanning all manifests for every `search`
  // call would be prohibitive on large libraries.
  const range = { blockStart: blockIndex, blockEnd: blockIndex };
  return buildSearchRow(entry, itemGroup, manifestCache, markdownCache, range, score, query);
}

function buildHybridSearchRow(
  entry: CatalogEntry,
  itemGroup: CatalogEntry[],
  manifestCache: Map<string, AttachmentManifest>,
  markdownCache: Map<string, string>,
  result: { bestChunkPos: number; bestChunk: string; score: number },
): SearchResultRow {
  const manifest = readManifestCached(entry, manifestCache);
  const range = {
    ...mapChunkToBlockRange(manifest, result.bestChunkPos, result.bestChunk),
    anchorOffset: Math.max(0, result.bestChunkPos + Math.floor(result.bestChunk.length / 2)),
  };
  return buildSearchRow(entry, itemGroup, manifestCache, markdownCache, range, result.score);
}

function docKeyFromSearchResultPath(resultPath: string): string | undefined {
  const normalized = resultPath.replace(/^qmd:\/\/[^/]+\//u, "");
  const match = normalized.match(/([a-f0-9]{40})\.md$/u);
  return match?.[1];
}

function renderMarkdownBlock(block: ManifestBlock): string {
  if (block.blockType === "heading") {
    const level = Math.max(1, Math.min(6, block.sectionPath.length || 1));
    return `${"#".repeat(level)} ${block.text}`;
  }
  if (block.blockType === "list item") {
    return `- ${block.text}`;
  }
  return block.text;
}

function normalizeBlockText(text: string): string {
  return cleanText(text).replace(/\s+/g, " ").trim().toLowerCase();
}

type FullTextRow = {
  itemKey: string;
  title: string;
  authors: string[];
  year?: string;
  files: string[];
  format: "markdown";
  source: "manifest" | "normalized";
  totalBlocks: number;
  keptBlocks: number;
  skippedBoilerplateBlocks: number;
  skippedDuplicateBlocks: number;
  content: string;
};

function renderManifestMarkdown(manifest: AttachmentManifest): string {
  const snippets: string[] = [];
  for (const block of manifest.blocks) {
    const text = cleanText(block.text);
    if (!text) continue;
    const snippet = renderMarkdownBlock({ ...block, text }).trim();
    if (!snippet) continue;
    snippets.push(snippet);
  }
  return cleanText(snippets.join("\n\n"));
}

export async function searchLiterature(
  query: string,
  limit: number,
  overrides: ConfigOverrides = {},
  qmdFactory: QmdFactory = openQmdClient,
  behavior: SearchBehaviorOptions = {},
  keywordFactory: KeywordIndexFactory = openKeywordIndex,
): Promise<{
  results: SearchResultRow[];
  warnings?: string[];
}> {
  const config = resolveConfig(overrides);
  const paths = getDataPaths(config.dataDir);
  const catalog = readCatalogFile(paths.catalogPath);
  const allReadyEntries = getReadyEntries(catalog);
  const itemKeyFilter = behavior.itemKeys !== undefined ? new Set(behavior.itemKeys) : undefined;
  if (behavior.semantic && itemKeyFilter !== undefined) {
    throw new Error("Tag filtering is currently supported for keyword search only.");
  }
  if (itemKeyFilter !== undefined && itemKeyFilter.size === 0) {
    return {
      results: [],
      ...(config.warnings.length > 0 ? { warnings: config.warnings } : {}),
    };
  }
  if (allReadyEntries.length === 0) {
    throw new Error("No indexed documents found. Run `zotagent sync` first.");
  }
  const readyEntries = itemKeyFilter
    ? allReadyEntries.filter((entry) => itemKeyFilter.has(entry.itemKey))
    : allReadyEntries;
  if (readyEntries.length === 0) {
    return {
      results: [],
      ...(config.warnings.length > 0 ? { warnings: config.warnings } : {}),
    };
  }

  const entryByDocKey = new Map(readyEntries.map((entry) => [entry.docKey, entry]));
  const itemGroups = groupReadyEntriesByItemKey(readyEntries);
  const manifestCache = new Map<string, AttachmentManifest>();
  const markdownCache = new Map<string, string>();

  let mapped: SearchResultRow[];

  if (behavior.semantic) {
    const qmd = await qmdFactory(config);
    try {
      behavior.progress?.("qmd search: running semantic query");
      const results = await qmd.search({
        query,
        limit,
        rerank: false,
        ...(behavior.minScore !== undefined ? { minScore: behavior.minScore } : {}),
      });
      mapped = results
        .map((result) => {
          const docKey =
            docKeyFromSearchResultPath(result.file) ?? docKeyFromSearchResultPath(result.displayPath);
          if (!docKey) return null;
          const entry = entryByDocKey.get(docKey);
          if (!entry) return null;
          const itemGroup = itemGroups.get(entry.itemKey) ?? [entry];
          return buildHybridSearchRow(entry, itemGroup, manifestCache, markdownCache, result);
        })
        .filter((value): value is ReturnType<typeof buildHybridSearchRow> => value !== null)
        .sort((a, b) => b.score - a.score);
    } finally {
      await qmd.close();
    }
  } else {
    // Keyword search (default): FTS5 over the per-block index. Each result is
    // already (docKey, bestBlockIndex, score) — no doc-level FTS table, no
    // hand-rolled passage scorer. Title queries belong in `metadata`.
    const keywordIndex = await keywordFactory(config);
    try {
      // Bootstrap the keyword index lazily if it is empty (e.g. first search after upgrade).
      const ftsOptions = itemKeyFilter ? { docKeys: readyEntries.map((entry) => entry.docKey) } : undefined;
      let results = await keywordIndex.searchDocs(query, limit, ftsOptions);
      if (results.length === 0 && allReadyEntries.length > 0 && (await keywordIndex.isEmpty())) {
        await keywordIndex.rebuildIndex(allReadyEntries);
        results = await keywordIndex.searchDocs(query, limit, ftsOptions);
      }
      mapped = results
        .filter((result) => behavior.minScore === undefined || result.score >= behavior.minScore)
        .map((result) => {
          const entry = entryByDocKey.get(result.docKey);
          if (!entry) return null;
          const itemGroup = itemGroups.get(entry.itemKey) ?? [entry];
          return buildKeywordSearchRow(entry, itemGroup, manifestCache, markdownCache, result.blockIndex, result.score, query);
        })
        .filter((value): value is SearchResultRow => value !== null)
        .sort((a, b) => b.score - a.score);
    } finally {
      await keywordIndex.close();
    }
  }

  return {
    results: mapped.slice(0, limit),
    ...(config.warnings.length > 0 ? { warnings: config.warnings } : {}),
  };
}

export async function searchWithinDocuments(
  query: string,
  input: { key: string },
  limit: number,
  overrides: ConfigOverrides = {},
  keywordFactory: KeywordIndexFactory = openKeywordIndex,
): Promise<{
  results: SearchResultRow[];
  warnings: string[];
}> {
  if (!query || !query.trim()) {
    throw new Error("Missing search text. Use: zotagent search-in \"<text>\" --key <key>");
  }

  const config = resolveConfig(overrides);
  const paths = getDataPaths(config.dataDir);
  const catalog = readCatalogFile(paths.catalogPath);
  const readyEntries = getReadyEntries(catalog);
  const entries = resolveReadyEntries(input.key, readyEntries);
  const targetDocKeys = entries.map((entry) => entry.docKey);
  const manifestCache = new Map<string, AttachmentManifest>();
  const markdownCache = new Map<string, string>();
  const mapped: SearchResultRow[] = [];

  const ftsOptions = { docKeys: targetDocKeys };
  const keywordIndex = await keywordFactory(config);
  try {
    let blockResults = await keywordIndex.searchBlocks(query, limit, ftsOptions);
    if (blockResults.length === 0 && readyEntries.length > 0 && (await keywordIndex.isEmpty())) {
      await keywordIndex.rebuildIndex(readyEntries);
      blockResults = await keywordIndex.searchBlocks(query, limit, ftsOptions);
    }

    const entryByDocKey = new Map(entries.map((entry) => [entry.docKey, entry]));

    // FTS5 phrase queries do not cross row boundaries, so a citation that
    // wraps mid-line into the next paragraph would be missed by per-block
    // FTS alone. Run the manifest-level scanner only when the query is a
    // single quoted phrase: that is the unambiguous "find this string"
    // intent, and FTS5 handles every other case (operators, multiple
    // phrases, bare multi-word queries) correctly on its own. Stripping
    // operators to manufacture a substring would resurface blocks FTS5
    // legitimately excluded — e.g. `alpha NOT beta` would otherwise pull
    // in any block containing `alpha beta`.
    const singlePhrase = singleQuotedPhrase(query);
    if (singlePhrase) {
      const normalizedPhrase = normalizeExactText(singlePhrase);
      if (normalizedPhrase) {
        for (const entry of entries) {
          const manifest = readManifestCached(entry, manifestCache);
          const exactRange = findExactPhraseBlockRange(manifest, normalizedPhrase, { tokenBoundaries: true });
          if (exactRange) {
            mapped.push(buildSearchRow(
              entry, entries, manifestCache, markdownCache, exactRange,
              100 - (exactRange.blockEnd - exactRange.blockStart),
              query,
            ));
          }
        }
      }
    }

    for (const result of blockResults) {
      const entry = entryByDocKey.get(result.docKey);
      if (!entry) continue;
      const range = { blockStart: result.blockIndex, blockEnd: result.blockIndex };
      mapped.push(buildSearchRow(entry, entries, manifestCache, markdownCache, range, result.score, query));
    }
  } finally {
    await keywordIndex.close();
  }

  // Dedupe by (itemKey, charOffset) — exact-phrase scan and per-block
  // FTS may surface the same hit anchor; keep the higher-scored row.
  const seen = new Map<string, SearchResultRow>();
  for (const row of mapped) {
    const key = `${row.itemKey}:${row.charOffset}`;
    const existing = seen.get(key);
    if (!existing || row.score > existing.score) {
      seen.set(key, row);
    }
  }
  const ordered = [...seen.values()].sort((a, b) => b.score - a.score || a.charOffset - b.charOffset);

  return {
    results: ordered.slice(0, limit),
    warnings: config.warnings,
  };
}

export function getDocumentBlocks(
  input: { key: string; offsetBlock: number; limitBlocks: number },
  overrides: ConfigOverrides = {},
): {
  itemKey: string;
  title: string;
  authors: string[];
  year?: string;
  files: string[];
  totalBlocks: number;
  blocks: Array<{
    blockIndex: number;
    blockType: string;
    sectionPath: string[];
    text: string;
    pageStart?: number;
    pageEnd?: number;
  }>;
  warnings: string[];
} {
  const config = resolveConfig(overrides);
  const catalog = readCatalogFile(getDataPaths(config.dataDir).catalogPath);
  const entries = resolveReadyEntries(input.key, getReadyEntries(catalog));
  const manifestCache = new Map<string, AttachmentManifest>();
  const manifest = loadMergedManifestForGroup(entries, manifestCache);
  const primary = entries[0]!;
  const blocks = manifest.blocks.slice(input.offsetBlock, input.offsetBlock + input.limitBlocks);
  return {
    itemKey: primary.itemKey,
    title: primary.title,
    authors: primary.authors,
    ...(primary.year ? { year: primary.year } : {}),
    files: itemFilePaths(entries),
    totalBlocks: manifest.blocks.length,
    blocks: blocks.map((block) => ({
      blockIndex: block.blockIndex,
      blockType: block.blockType,
      sectionPath: block.sectionPath,
      text: block.text,
      pageStart: block.pageStart,
      pageEnd: block.pageEnd,
    })),
    warnings: config.warnings,
  };
}

function buildFullTextRow(
  entries: CatalogEntry[],
  manifestCache: Map<string, AttachmentManifest>,
  options: { clean?: boolean } = {},
): FullTextRow {
  const primary = entries[0]!;
  const manifest = loadMergedManifestForGroup(entries, manifestCache);

  if (!options.clean) {
    let content = "";
    let source: "manifest" | "normalized" = "manifest";

    const allHaveNormalized = entries.every(
      (entry) => entry.normalizedPath && exists(entry.normalizedPath),
    );

    if (entries.length === 1 && allHaveNormalized) {
      content = cleanText(readFileSync(primary.normalizedPath!, "utf-8"));
      source = "normalized";
    } else if (allHaveNormalized) {
      const parts = entries.map((entry, i) => {
        const body = cleanText(readFileSync(entry.normalizedPath!, "utf-8"));
        if (i === 0) return body;
        const basename = pathBasename(entry.filePath) || "attachment";
        return `# Attachment: ${basename}\n\n${body}`;
      });
      content = cleanText(parts.join("\n\n"));
      source = "normalized";
    } else {
      content = renderManifestMarkdown(manifest);
    }

    if (!content) {
      throw new Error(`No readable full text found for item: ${primary.itemKey}`);
    }

    return {
      itemKey: primary.itemKey,
      title: primary.title,
      authors: primary.authors,
      ...(primary.year ? { year: primary.year } : {}),
      files: itemFilePaths(entries),
      format: "markdown",
      source,
      totalBlocks: manifest.blocks.length,
      keptBlocks: manifest.blocks.length,
      skippedBoilerplateBlocks: 0,
      skippedDuplicateBlocks: 0,
      content,
    };
  }

  const earlyNoiseWindow = Math.max(8, Math.min(30, Math.ceil(manifest.blocks.length * 0.15)));
  const seenBodyBlocks = new Set<string>();
  const snippets: string[] = [];
  let skippedBoilerplateBlocks = 0;
  let skippedDuplicateBlocks = 0;

  for (const block of manifest.blocks) {
    const text = cleanText(block.text);
    if (!text) continue;

    const looksLikeBoilerplate =
      isBoilerplateLikeText(text)
      || (block.blockIndex < earlyNoiseWindow && isTableOfContentsLikeText(text));
    if (looksLikeBoilerplate) {
      skippedBoilerplateBlocks += 1;
      continue;
    }

    if (block.blockType !== "heading") {
      const dedupeKey = `${block.blockType}:${normalizeBlockText(text)}`;
      if (seenBodyBlocks.has(dedupeKey)) {
        skippedDuplicateBlocks += 1;
        continue;
      }
      seenBodyBlocks.add(dedupeKey);
    }

    const snippet = renderMarkdownBlock({ ...block, text }).trim();
    if (!snippet) continue;
    snippets.push(snippet);
  }

  const content = cleanText(snippets.join("\n\n"));
  if (!content) {
    throw new Error(`No readable full text found for item: ${primary.itemKey}`);
  }

  return {
    itemKey: primary.itemKey,
    title: primary.title,
    authors: primary.authors,
    ...(primary.year ? { year: primary.year } : {}),
    files: itemFilePaths(entries),
    format: "markdown",
    source: "manifest",
    totalBlocks: manifest.blocks.length,
    keptBlocks: snippets.length,
    skippedBoilerplateBlocks,
    skippedDuplicateBlocks,
    content,
  };
}

export function fullTextDocument(
  input: { key: string; clean?: boolean },
  overrides: ConfigOverrides = {},
): FullTextRow & { warnings: string[] } {
  const config = resolveConfig(overrides);
  const catalog = readCatalogFile(getDataPaths(config.dataDir).catalogPath);
  const entries = resolveReadyEntries(input.key, getReadyEntries(catalog));
  const manifestCache = new Map<string, AttachmentManifest>();
  const row = buildFullTextRow(entries, manifestCache, { clean: input.clean });
  return { ...row, warnings: config.warnings };
}

export function expandDocument(
  input: { key: string; offset: number; radius: number },
  overrides: ConfigOverrides = {},
): {
  itemKey: string;
  title: string;
  authors: string[];
  year?: string;
  files: string[];
  passage: string;
  // Actual char bounds of the returned slice (clamped to the document).
  passageStart: number;
  passageEnd: number;
  // Page numbers from the blocks that overlap the slice, where the
  // extractor recorded them. Use these for citation locators.
  pageStart?: number;
  pageEnd?: number;
  warnings: string[];
} {
  const config = resolveConfig(overrides);
  const catalog = readCatalogFile(getDataPaths(config.dataDir).catalogPath);
  const entries = resolveReadyEntries(input.key, getReadyEntries(catalog));
  const manifestCache = new Map<string, AttachmentManifest>();
  const manifest = loadMergedManifestForGroup(entries, manifestCache);
  const markdown = renderManifestMarkdown(manifest);
  const primary = entries[0]!;

  const center = Math.max(0, Math.min(markdown.length, input.offset));
  const passageStart = Math.max(0, center - input.radius);
  const passageEnd = Math.min(markdown.length, center + input.radius);

  // Pages: pull from the blocks that overlap the slice. First overlapping
  // block with a recorded pageStart sets the lower bound; last with pageEnd
  // sets the upper. EPUB has no pages, and some PDF extractors leave them
  // unset — the fields stay absent in that case.
  const overlapping = manifest.blocks.filter(
    (b) => b.charStart < passageEnd && b.charEnd > passageStart,
  );
  const firstWithPage = overlapping.find((b) => b.pageStart !== undefined);
  const lastWithPage = [...overlapping].reverse().find((b) => b.pageEnd !== undefined);

  return {
    itemKey: primary.itemKey,
    title: primary.title,
    authors: primary.authors,
    ...(primary.year ? { year: primary.year } : {}),
    files: itemFilePaths(entries),
    passage: markdown.slice(passageStart, passageEnd),
    passageStart,
    passageEnd,
    ...(firstWithPage?.pageStart !== undefined ? { pageStart: firstWithPage.pageStart } : {}),
    ...(lastWithPage?.pageEnd !== undefined ? { pageEnd: lastWithPage.pageEnd } : {}),
    warnings: config.warnings,
  };
}

export async function getIndexStatus(
  overrides: ConfigOverrides = {},
  qmdFactory: QmdFactory = openQmdClient,
): Promise<{
  counts: ReturnType<typeof summarizeCatalog>;
  paths: ReturnType<typeof getDataPaths>;
  qmd: unknown;
  warnings: string[];
}> {
  const config = resolveConfig(overrides);
  const paths = getDataPaths(config.dataDir);
  const catalog = readCatalogFile(paths.catalogPath);
  const counts = summarizeCatalog(catalog);

  let qmd: unknown = {};
  if (exists(paths.qmdDbPath)) {
    const client = await qmdFactory(config);
    try {
      qmd = await client.getStatus();
    } finally {
      await client.close();
    }
  }

  return {
    counts,
    paths,
    qmd,
    warnings: config.warnings,
  };
}
