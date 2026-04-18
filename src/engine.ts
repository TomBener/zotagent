import { readFileSync } from "node:fs";
import { basename as pathBasename } from "node:path";

import { getDataPaths, resolveConfig, type ConfigOverrides } from "./config.js";
import { findExactPhraseBlockRange, normalizeExactText } from "./exact.js";
import { isBoilerplateLikeText, isTableOfContentsLikeText } from "./heuristics.js";
import { maskQuotedPhrases, openKeywordIndex, unmaskQuotedPhrases, type KeywordIndexFactory } from "./keyword-db.js";
import { mergeManifestsForItem } from "./manifest.js";
import { openQmdClient, type QmdFactory } from "./qmd.js";
import { getReadyEntries, readCatalogFile, summarizeCatalog } from "./state.js";
import type { AttachmentManifest, CatalogEntry, ManifestBlock, SearchResultRow } from "./types.js";
import { cleanText, compactHomePath, exists, overlap, readManifestFile } from "./utils.js";

interface SearchBehaviorOptions {
  semantic?: boolean;
  minScore?: number;
  progress?: (message: string) => void;
}

interface KeywordQueryProfile {
  normalizedQuery: string;
  terms: string[];
}

type VerifiedSearchRow = SearchResultRow & { referenceOnly: boolean };

function resolveReadyEntries(
  selector: { itemKey?: string; citationKey?: string },
  entries: CatalogEntry[],
): CatalogEntry[] {
  const selectors = [
    selector.itemKey ? "--item-key <key>" : null,
    selector.citationKey ? "--citation-key <key>" : null,
  ].filter((value): value is string => value !== null);

  if (selectors.length > 1) {
    throw new Error("Provide exactly one of --item-key <key> or --citation-key <key>.");
  }

  if (selector.itemKey) {
    const matched = entries
      .filter((entry) => entry.itemKey === selector.itemKey)
      .sort((a, b) => a.filePath.localeCompare(b.filePath));
    if (matched.length === 0) {
      throw new Error(`No indexed attachment found for itemKey: ${selector.itemKey}`);
    }
    return matched;
  }

  if (selector.citationKey) {
    const matched = entries
      .filter((entry) => entry.citationKey === selector.citationKey)
      .sort((a, b) => a.filePath.localeCompare(b.filePath));
    if (matched.length === 0) {
      throw new Error(`No indexed attachment found for citationKey: ${selector.citationKey}`);
    }
    return matched;
  }

  throw new Error("Provide one of --item-key <key> or --citation-key <key>.");
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

function buildSearchRow(
  entry: CatalogEntry,
  manifest: AttachmentManifest,
  range: { blockStart: number; blockEnd: number },
  globalOffset: number,
  score: number,
): VerifiedSearchRow {
  const blocks = manifest.blocks.filter(
    (block) => block.blockIndex >= range.blockStart && block.blockIndex <= range.blockEnd,
  );
  const referenceOnly = blocks.length > 0 && blocks.every((block) => block.isReferenceLike);

  return {
    itemKey: entry.itemKey,
    ...(entry.citationKey ? { citationKey: entry.citationKey } : {}),
    title: entry.title,
    authors: entry.authors,
    ...(entry.year ? { year: entry.year } : {}),
    passage: blocks.map((block) => block.text).join("\n\n"),
    blockStart: range.blockStart + globalOffset,
    blockEnd: range.blockEnd + globalOffset,
    score: Math.round((score - (referenceOnly ? 0.05 : 0)) * 10000) / 10000,
    referenceOnly,
  };
}

function buildTitleSearchRow(
  entry: CatalogEntry,
  globalOffset: number,
  score: number,
): VerifiedSearchRow {
  return {
    itemKey: entry.itemKey,
    ...(entry.citationKey ? { citationKey: entry.citationKey } : {}),
    title: entry.title,
    authors: entry.authors,
    ...(entry.year ? { year: entry.year } : {}),
    passage: entry.title,
    blockStart: globalOffset,
    blockEnd: globalOffset,
    score: Math.round(score * 10000) / 10000,
    referenceOnly: false,
  };
}

/**
 * Strip FTS5 operators, distance parameters, and parens so only content words
 * remain for passage-layer scoring. Quoted phrases pass through untouched so
 * `"black AND white"` or `"foo NEAR bar"` are treated as the exact phrases the
 * user asked for. Public proximity syntax is `left NEAR/<n> right`; the NEAR(...)
 * unwrap is kept for the internal FTS form and does not strip unrelated
 * `(..., 2020)` substrings.
 */
function stripFtsOperators(query: string): string {
  const { masked, phrases } = maskQuotedPhrases(query);
  const stripped = masked
    // Unwrap `NEAR(a b [, N])` → ` a b `, dropping the call keyword, distance arg, and parens.
    .replace(/\bNEAR\s*\(\s*([^()]+?)\s*(?:,\s*\d+\s*)?\)/gi, " $1 ")
    // Drop remaining bare operator words.
    .replace(/\b(?:AND|OR|NOT|NEAR(?:\/\d+)?)\b/gi, " ")
    // Drop any stray parens left over from malformed input.
    .replace(/[()]/g, " ");
  return unmaskQuotedPhrases(stripped, phrases);
}

/** Extract content words from an FTS5 query, stripping operators. */
function extractQueryTerms(query: string): string[] {
  return stripFtsOperators(query).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function tokenizeKeywordText(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function isKeywordConsonant(word: string, index: number): boolean {
  const char = word[index];
  if (char === undefined) return false;
  if ("aeiou".includes(char)) return false;
  if (char === "y") {
    return index === 0 ? true : !isKeywordConsonant(word, index - 1);
  }
  return true;
}

function keywordMeasure(word: string): number {
  let count = 0;
  let index = 0;
  while (index < word.length) {
    while (index < word.length && isKeywordConsonant(word, index)) index += 1;
    if (index >= word.length) break;
    while (index < word.length && !isKeywordConsonant(word, index)) index += 1;
    count += 1;
  }
  return count;
}

function keywordContainsVowel(word: string): boolean {
  for (let index = 0; index < word.length; index += 1) {
    if (!isKeywordConsonant(word, index)) return true;
  }
  return false;
}

function keywordEndsWithDoubleConsonant(word: string): boolean {
  return (
    word.length >= 2
    && word[word.length - 1] === word[word.length - 2]
    && isKeywordConsonant(word, word.length - 1)
  );
}

function keywordEndsWithCvc(word: string): boolean {
  if (word.length < 3) return false;
  const a = word.length - 3;
  const b = word.length - 2;
  const c = word.length - 1;
  if (!isKeywordConsonant(word, a) || isKeywordConsonant(word, b) || !isKeywordConsonant(word, c)) {
    return false;
  }
  const last = word[c];
  return last !== "w" && last !== "x" && last !== "y";
}

function stemKeywordToken(token: string): string {
  if (!/^[a-z]+$/u.test(token) || token.length < 3) return token;

  let word = token;
  const replaceSuffix = (suffix: string, replacement: string, minimumMeasure: number): boolean => {
    if (!word.endsWith(suffix)) return false;
    const stem = word.slice(0, -suffix.length);
    if (keywordMeasure(stem) <= minimumMeasure) return false;
    word = stem + replacement;
    return true;
  };

  if (word.endsWith("sses")) {
    word = word.slice(0, -2);
  } else if (word.endsWith("ies")) {
    word = word.slice(0, -2);
  } else if (word.endsWith("ss")) {
    // Keep "ss" intact.
  } else if (word.endsWith("s")) {
    word = word.slice(0, -1);
  }

  let strippedEdOrIng = false;
  if (word.endsWith("eed")) {
    const stem = word.slice(0, -3);
    if (keywordMeasure(stem) > 0) word = stem + "ee";
  } else if (word.endsWith("ed")) {
    const stem = word.slice(0, -2);
    if (keywordContainsVowel(stem)) {
      word = stem;
      strippedEdOrIng = true;
    }
  } else if (word.endsWith("ing")) {
    const stem = word.slice(0, -3);
    if (keywordContainsVowel(stem)) {
      word = stem;
      strippedEdOrIng = true;
    }
  }

  if (strippedEdOrIng) {
    if (word.endsWith("at") || word.endsWith("bl") || word.endsWith("iz")) {
      word += "e";
    } else if (keywordEndsWithDoubleConsonant(word) && !/[lsz]$/u.test(word)) {
      word = word.slice(0, -1);
    } else if (keywordMeasure(word) === 1 && keywordEndsWithCvc(word)) {
      word += "e";
    }
  }

  if (word.endsWith("y")) {
    const stem = word.slice(0, -1);
    if (keywordContainsVowel(stem)) word = stem + "i";
  }

  const step2: Array<[string, string]> = [
    ["ational", "ate"],
    ["tional", "tion"],
    ["enci", "ence"],
    ["anci", "ance"],
    ["izer", "ize"],
    ["abli", "able"],
    ["alli", "al"],
    ["entli", "ent"],
    ["eli", "e"],
    ["ousli", "ous"],
    ["ization", "ize"],
    ["ation", "ate"],
    ["ator", "ate"],
    ["alism", "al"],
    ["iveness", "ive"],
    ["fulness", "ful"],
    ["ousness", "ous"],
    ["aliti", "al"],
    ["iviti", "ive"],
    ["biliti", "ble"],
    ["logi", "log"],
  ];
  for (const [suffix, replacement] of step2) {
    if (replaceSuffix(suffix, replacement, 0)) break;
  }

  const step3: Array<[string, string]> = [
    ["icate", "ic"],
    ["ative", ""],
    ["alize", "al"],
    ["iciti", "ic"],
    ["ical", "ic"],
    ["ful", ""],
    ["ness", ""],
  ];
  for (const [suffix, replacement] of step3) {
    if (replaceSuffix(suffix, replacement, 0)) break;
  }

  const step4 = [
    "ement",
    "ance",
    "ence",
    "able",
    "ible",
    "ment",
    "ant",
    "ent",
    "ism",
    "ate",
    "iti",
    "ous",
    "ive",
    "ize",
    "al",
    "er",
    "ic",
    "ou",
  ];
  for (const suffix of step4) {
    if (replaceSuffix(suffix, "", 1)) break;
  }
  if (word.endsWith("ion")) {
    const stem = word.slice(0, -3);
    if (keywordMeasure(stem) > 1 && /[st]$/u.test(stem)) {
      word = stem;
    }
  }

  if (word.endsWith("e")) {
    const stem = word.slice(0, -1);
    const measure = keywordMeasure(stem);
    if (measure > 1 || (measure === 1 && !keywordEndsWithCvc(stem))) {
      word = stem;
    }
  }

  if (keywordMeasure(word) > 1 && keywordEndsWithDoubleConsonant(word) && word.endsWith("l")) {
    word = word.slice(0, -1);
  }

  return word;
}

function buildKeywordQueryProfile(query: string): KeywordQueryProfile {
  const stripped = stripFtsOperators(query);
  return {
    normalizedQuery: normalizeExactText(stripped),
    terms: [...new Set(extractQueryTerms(query).map((term) => stemKeywordToken(term)).filter((term) => term.length > 0))],
  };
}

const CJK_CHAR_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function scoreKeywordText(text: string, query: KeywordQueryProfile): number {
  const normalized = normalizeExactText(text);
  const phraseHits = query.normalizedQuery ? countOccurrences(normalized, query.normalizedQuery) : 0;
  const tokenCounts = new Map<string, number>();
  for (const token of tokenizeKeywordText(text)) {
    const stem = stemKeywordToken(token);
    tokenCounts.set(stem, (tokenCounts.get(stem) ?? 0) + 1);
  }

  let matchedTerms = 0;
  let totalTermHits = 0;
  for (const term of query.terms) {
    // CJK tokenizes as one run per `[\p{L}\p{N}]+`, so a user-visible CJK phrase like
    // "开发新疆" never appears as its own token bucket. Count substring occurrences in the
    // normalized text instead — collapseSegmentedCjkRuns guarantees spaced CJK is re-joined.
    const hits = CJK_CHAR_RE.test(term)
      ? countOccurrences(normalized, term)
      : (tokenCounts.get(term) ?? 0);
    if (hits > 0) {
      matchedTerms += 1;
      totalTermHits += hits;
    }
  }

  if (phraseHits === 0 && matchedTerms === 0) return 0;
  return (
    phraseHits * 10
    + (query.terms.length > 0 ? (matchedTerms / query.terms.length) * 4 : 0)
    + Math.min(totalTermHits, 5)
  );
}

function findBestBlockByTerms(
  manifest: AttachmentManifest,
  query: KeywordQueryProfile,
): { blockStart: number; blockEnd: number; score: number } | null {
  if (manifest.blocks.length === 0 || query.terms.length === 0) return null;

  let bestBlock: ManifestBlock | null = null;
  let bestScore = 0;

  for (const block of manifest.blocks) {
    if (block.isReferenceLike) continue;
    const baseScore = scoreKeywordText(`${block.sectionPath.join(" ")} ${block.text}`,
      query,
    );
    if (baseScore === 0) continue;

    const adjustedScore =
      baseScore
      + (block.blockType === "heading" ? 0.5 : 0)
      - (isBoilerplateLikeText(block.text) ? 1 : 0)
      - (isTableOfContentsLikeText(block.text) ? 1 : 0);
    if (adjustedScore <= 0) continue;
    if (!bestBlock || adjustedScore > bestScore) {
      bestBlock = block;
      bestScore = adjustedScore;
    }
  }

  return bestBlock
    ? { blockStart: bestBlock.blockIndex, blockEnd: bestBlock.blockIndex, score: bestScore }
    : null;
}

function buildKeywordSearchRow(
  entry: CatalogEntry,
  manifest: AttachmentManifest,
  query: KeywordQueryProfile,
  globalOffset: number,
  score: number,
): VerifiedSearchRow | null {
  const exactRange = query.normalizedQuery ? findExactPhraseBlockRange(manifest, query.normalizedQuery) : null;
  if (exactRange) {
    return buildSearchRow(entry, manifest, exactRange, globalOffset, score);
  }

  const bestBlock = findBestBlockByTerms(manifest, query);
  const titleScore = scoreKeywordText(entry.title, query);
  if (titleScore > (bestBlock?.score ?? 0)) {
    return buildTitleSearchRow(entry, globalOffset, score);
  }
  if (bestBlock) {
    return buildSearchRow(
      entry,
      manifest,
      { blockStart: bestBlock.blockStart, blockEnd: bestBlock.blockEnd },
      globalOffset,
      score,
    );
  }
  return null;
}

function buildHybridSearchRow(
  entry: CatalogEntry,
  manifest: AttachmentManifest,
  result: { bestChunkPos: number; bestChunk: string; score: number },
  globalOffset: number,
): VerifiedSearchRow {
  const range = mapChunkToBlockRange(manifest, result.bestChunkPos, result.bestChunk);
  return buildSearchRow(entry, manifest, range, globalOffset, result.score);
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

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

type FullTextRow = {
  itemKey: string;
  citationKey?: string;
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
  const readyEntries = getReadyEntries(catalog);
  if (readyEntries.length === 0) {
    throw new Error("No indexed documents found. Run `zotagent sync` first.");
  }

  const entryByDocKey = new Map(readyEntries.map((entry) => [entry.docKey, entry]));
  const itemGroups = groupReadyEntriesByItemKey(readyEntries);
  const manifestCache = new Map<string, AttachmentManifest>();

  let mapped: VerifiedSearchRow[];

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
          const globalOffset = attachmentGlobalOffset(entry, itemGroup, manifestCache);
          const manifest = readManifestCached(entry, manifestCache);
          return buildHybridSearchRow(entry, manifest, result, globalOffset);
        })
        .filter((value): value is ReturnType<typeof buildHybridSearchRow> => value !== null)
        .sort((a, b) => b.score - a.score);
    } finally {
      await qmd.close();
    }
  } else {
    // Keyword search (default): FTS5 with porter stemmer.
    const keywordIndex = await keywordFactory(config);
    try {
      // Bootstrap the keyword index lazily if it is empty (e.g. first search after upgrade).
      let results = await keywordIndex.search(query, limit);
      if (results.length === 0 && readyEntries.length > 0 && (await keywordIndex.isEmpty())) {
        await keywordIndex.rebuildIndex(readyEntries);
        results = await keywordIndex.search(query, limit);
      }
      const keywordQuery = buildKeywordQueryProfile(query);
      mapped = results
        .filter((result) => behavior.minScore === undefined || result.score >= behavior.minScore)
        .map((result) => {
          const entry = entryByDocKey.get(result.docKey);
          if (!entry) return null;
          const itemGroup = itemGroups.get(entry.itemKey) ?? [entry];
          const globalOffset = attachmentGlobalOffset(entry, itemGroup, manifestCache);
          const manifest = readManifestCached(entry, manifestCache);
          return buildKeywordSearchRow(entry, manifest, keywordQuery, globalOffset, result.score);
        })
        .filter((value): value is VerifiedSearchRow => value !== null)
        .sort((a, b) => b.score - a.score);
    } finally {
      await keywordIndex.close();
    }
  }

  const substantive = mapped.filter((row) => !row.referenceOnly);
  const references = mapped.filter((row) => row.referenceOnly);
  const ordered = substantive.length > 0 ? [...substantive, ...references] : mapped;

  return {
    results: ordered.slice(0, limit).map(({ referenceOnly: _referenceOnly, ...row }) => row),
    ...(config.warnings.length > 0 ? { warnings: config.warnings } : {}),
  };
}

export function searchWithinDocuments(
  query: string,
  input: { itemKey?: string; citationKey?: string },
  limit: number,
  overrides: ConfigOverrides = {},
): {
  results: SearchResultRow[];
  warnings: string[];
} {
  const normalizedQuery = normalizeExactText(query);
  if (!normalizedQuery) {
    throw new Error("Missing search text. Use: zotagent search-in \"<text>\" (--item-key <key> | --citation-key <key>)");
  }

  const queryTerms = [...new Set(normalizedQuery.split(" ").filter((term) => term.length > 0))];
  const config = resolveConfig(overrides);
  const catalog = readCatalogFile(getDataPaths(config.dataDir).catalogPath);
  const entries = resolveReadyEntries(input, getReadyEntries(catalog));
  const manifestCache = new Map<string, AttachmentManifest>();
  const mapped: Array<SearchResultRow & { referenceOnly: boolean }> = [];

  let globalOffset = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const manifest = readManifestCached(entry, manifestCache);
    const candidates = new Map<string, { range: { blockStart: number; blockEnd: number }; score: number }>();
    const exactRange = findExactPhraseBlockRange(manifest, query);
    if (exactRange) {
      candidates.set(`${exactRange.blockStart}:${exactRange.blockEnd}`, {
        range: exactRange,
        score: 100 - (exactRange.blockEnd - exactRange.blockStart),
      });
    }

    for (const block of manifest.blocks) {
      const haystack = normalizeExactText(`${block.sectionPath.join(" ")} ${block.text}`);
      if (!haystack) continue;

      const phraseHits = countOccurrences(haystack, normalizedQuery);
      let matchedTerms = 0;
      let totalTermHits = 0;
      for (const term of queryTerms) {
        const hits = countOccurrences(haystack, term);
        if (hits > 0) {
          matchedTerms += 1;
          totalTermHits += hits;
        }
      }
      if (phraseHits === 0 && matchedTerms === 0) continue;

      const score =
        phraseHits * 10
        + (queryTerms.length > 0 ? (matchedTerms / queryTerms.length) * 4 : 0)
        + Math.min(totalTermHits, 5)
        + (block.blockType === "heading" ? 0.5 : 0);
      const key = `${block.blockIndex}:${block.blockIndex}`;
      const existing = candidates.get(key);
      if (!existing || score > existing.score) {
        candidates.set(key, {
          range: { blockStart: block.blockIndex, blockEnd: block.blockIndex },
          score,
        });
      }
    }

    const offset = globalOffset;
    mapped.push(
      ...[...candidates.values()]
        .sort((a, b) => b.score - a.score || a.range.blockStart - b.range.blockStart)
        .map((candidate) => buildSearchRow(entry, manifest, candidate.range, offset, candidate.score)),
    );

    globalOffset += manifest.blocks.length + (i < entries.length - 1 ? 1 : 0);
  }

  const substantive = mapped.filter((row) => !row.referenceOnly);
  const references = mapped.filter((row) => row.referenceOnly);
  const ordered = substantive.length > 0 ? [...substantive, ...references] : mapped;

  return {
    results: ordered.slice(0, limit).map(({ referenceOnly: _referenceOnly, ...row }) => row),
    warnings: config.warnings,
  };
}

export function readDocument(
  input: { itemKey?: string; citationKey?: string; offsetBlock: number; limitBlocks: number },
  overrides: ConfigOverrides = {},
): {
  itemKey: string;
  citationKey?: string;
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
  const entries = resolveReadyEntries(input, getReadyEntries(catalog));
  const manifestCache = new Map<string, AttachmentManifest>();
  const manifest = loadMergedManifestForGroup(entries, manifestCache);
  const primary = entries[0]!;
  const blocks = manifest.blocks.slice(input.offsetBlock, input.offsetBlock + input.limitBlocks);
  return {
    itemKey: primary.itemKey,
    ...(primary.citationKey ? { citationKey: primary.citationKey } : {}),
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
      ...(primary.citationKey ? { citationKey: primary.citationKey } : {}),
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
    ...(primary.citationKey ? { citationKey: primary.citationKey } : {}),
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
  input: { itemKey?: string; citationKey?: string; clean?: boolean },
  overrides: ConfigOverrides = {},
): FullTextRow & { warnings: string[] } {
  const config = resolveConfig(overrides);
  const catalog = readCatalogFile(getDataPaths(config.dataDir).catalogPath);
  const entries = resolveReadyEntries(input, getReadyEntries(catalog));
  const manifestCache = new Map<string, AttachmentManifest>();
  const row = buildFullTextRow(entries, manifestCache, { clean: input.clean });
  return { ...row, warnings: config.warnings };
}

export function expandDocument(
  input: { itemKey?: string; citationKey?: string; blockStart: number; blockEnd: number; radius: number },
  overrides: ConfigOverrides = {},
): {
  itemKey: string;
  citationKey?: string;
  title: string;
  authors: string[];
  year?: string;
  files: string[];
  contextStart: number;
  contextEnd: number;
  blockStart: number;
  blockEnd: number;
  passage: string;
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
  const entries = resolveReadyEntries(input, getReadyEntries(catalog));
  const manifestCache = new Map<string, AttachmentManifest>();
  const manifest = loadMergedManifestForGroup(entries, manifestCache);
  const primary = entries[0]!;
  const contextStart = Math.max(0, input.blockStart - input.radius);
  const contextEnd = Math.min(manifest.blocks.length - 1, input.blockEnd + input.radius);
  const blocks = manifest.blocks.filter(
    (block) => block.blockIndex >= contextStart && block.blockIndex <= contextEnd,
  );
  const passageBlocks = blocks.filter(
    (block) => block.blockIndex >= input.blockStart && block.blockIndex <= input.blockEnd,
  );

  return {
    itemKey: primary.itemKey,
    ...(primary.citationKey ? { citationKey: primary.citationKey } : {}),
    title: primary.title,
    authors: primary.authors,
    ...(primary.year ? { year: primary.year } : {}),
    files: itemFilePaths(entries),
    contextStart,
    contextEnd,
    blockStart: input.blockStart,
    blockEnd: input.blockEnd,
    passage: passageBlocks.map((block) => block.text).join("\n\n"),
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
