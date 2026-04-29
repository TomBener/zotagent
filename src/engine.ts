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

interface SearchBehaviorOptions {
  semantic?: boolean;
  minScore?: number;
  progress?: (message: string) => void;
}

type VerifiedSearchRow = SearchResultRow & { referenceOnly: boolean };

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
    title: entry.title,
    authors: entry.authors,
    ...(entry.year ? { year: entry.year } : {}),
    passage: truncateSearchPassage(blocks.map((block) => block.text).join("\n\n")),
    blockStart: range.blockStart + globalOffset,
    blockEnd: range.blockEnd + globalOffset,
    score: Math.round((score - (referenceOnly ? 0.05 : 0)) * 10000) / 10000,
    referenceOnly,
  };
}

/**
 * If the query is a single quoted multi-token phrase (e.g. `"Ho, Peter. 2017"`)
 * with no operators or other content outside the quotes, return the inner
 * phrase text; otherwise null. Used to gate the supplemental cross-block
 * phrase scan in search-in: any other query shape is FTS5's responsibility,
 * and stripping operators to manufacture a substring would resurface blocks
 * FTS5 legitimately excluded (e.g. `alpha NOT beta`). Single-token quoted
 * queries are skipped because per-block FTS already finds every occurrence
 * of a single token, and substring matching on a short token would falsely
 * "hit" prefixes of unrelated words like `how` for `ho`.
 */
function singleQuotedPhrase(query: string): string | null {
  const { masked, phrases } = maskQuotedPhrases(query);
  if (phrases.length !== 1) return null;
  const remainder = masked.replace(/\uE000Q\d+\uE001/gu, "").trim();
  if (remainder.length > 0) return null;
  const inner = phrases[0]!.slice(1, -1);
  const tokens = inner.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length < 2) return null;
  return inner;
}

function buildKeywordSearchRow(
  entry: CatalogEntry,
  manifest: AttachmentManifest,
  blockIndex: number,
  globalOffset: number,
  score: number,
): VerifiedSearchRow | null {
  // FTS5 already returned this doc's best matching block; just frame the
  // single-block range. Block-level FTS does not match phrases that wrap a
  // block boundary — that gap is left to `search-in` (which has a manifest-
  // level cross-block scan), since scanning all manifests for every `search`
  // call would be prohibitive on large libraries.
  const range = { blockStart: blockIndex, blockEnd: blockIndex };
  return buildSearchRow(entry, manifest, range, globalOffset, score);
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
    // Keyword search (default): FTS5 over the per-block index. Each result is
    // already (docKey, bestBlockIndex, score) — no doc-level FTS table, no
    // hand-rolled passage scorer. Title queries belong in `metadata`.
    const keywordIndex = await keywordFactory(config);
    try {
      // Bootstrap the keyword index lazily if it is empty (e.g. first search after upgrade).
      let results = await keywordIndex.searchDocs(query, limit);
      if (results.length === 0 && readyEntries.length > 0 && (await keywordIndex.isEmpty())) {
        await keywordIndex.rebuildIndex(readyEntries);
        results = await keywordIndex.searchDocs(query, limit);
      }
      const collected: VerifiedSearchRow[] = [];
      for (const result of results) {
        if (behavior.minScore !== undefined && result.score < behavior.minScore) continue;
        const entry = entryByDocKey.get(result.docKey);
        if (!entry) continue;
        const itemGroup = itemGroups.get(entry.itemKey) ?? [entry];
        const globalOffset = attachmentGlobalOffset(entry, itemGroup, manifestCache);
        const manifest = readManifestCached(entry, manifestCache);

        // Reference-aware passage selection. FTS5's MIN(rank) per doc may pick
        // a citation list block when the query token repeats in references —
        // e.g. searching "Acemoglu" in a paper that cites him many times. The
        // doc IS relevant (keep its overall rank), but the displayed passage
        // should come from substantive prose where one exists. Only fires for
        // affected docs, so the extra searchBlocks roundtrip is bounded.
        let chosenBlockIndex = result.blockIndex;
        const initialBlock = manifest.blocks.find((b) => b.blockIndex === result.blockIndex);
        if (initialBlock?.isReferenceLike) {
          const candidates = await keywordIndex.searchBlocks(query, 20, { docKeys: [result.docKey] });
          for (const candidate of candidates) {
            const candBlock = manifest.blocks.find((b) => b.blockIndex === candidate.blockIndex);
            if (candBlock && !candBlock.isReferenceLike) {
              chosenBlockIndex = candidate.blockIndex;
              break;
            }
          }
        }

        const row = buildKeywordSearchRow(entry, manifest, chosenBlockIndex, globalOffset, result.score);
        if (row !== null) collected.push(row);
      }
      mapped = collected.sort((a, b) => b.score - a.score);
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
  const mapped: VerifiedSearchRow[] = [];

  const ftsOptions = { docKeys: targetDocKeys };
  const keywordIndex = await keywordFactory(config);
  try {
    let blockResults = await keywordIndex.searchBlocks(query, limit, ftsOptions);
    if (blockResults.length === 0 && readyEntries.length > 0 && (await keywordIndex.isEmpty())) {
      await keywordIndex.rebuildIndex(readyEntries);
      blockResults = await keywordIndex.searchBlocks(query, limit, ftsOptions);
    }

    const entryByDocKey = new Map(entries.map((entry) => [entry.docKey, entry]));
    const offsetByDocKey = new Map<string, number>();
    let runningOffset = 0;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!;
      offsetByDocKey.set(entry.docKey, runningOffset);
      const manifest = readManifestCached(entry, manifestCache);
      runningOffset += manifest.blocks.length + (i < entries.length - 1 ? 1 : 0);
    }

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
            const offset = offsetByDocKey.get(entry.docKey) ?? 0;
            mapped.push(buildSearchRow(
              entry, manifest, exactRange, offset,
              100 - (exactRange.blockEnd - exactRange.blockStart),
            ));
          }
        }
      }
    }

    for (const result of blockResults) {
      const entry = entryByDocKey.get(result.docKey);
      if (!entry) continue;
      const manifest = readManifestCached(entry, manifestCache);
      const offset = offsetByDocKey.get(entry.docKey) ?? 0;
      const range = { blockStart: result.blockIndex, blockEnd: result.blockIndex };
      mapped.push(buildSearchRow(entry, manifest, range, offset, result.score));
    }
  } finally {
    await keywordIndex.close();
  }

  // Dedupe by (itemKey, blockStart, blockEnd) — exact-phrase scan and per-block
  // FTS may surface the same block; keep the higher-scored row.
  const seen = new Map<string, VerifiedSearchRow>();
  for (const row of mapped) {
    const key = `${row.itemKey}:${row.blockStart}:${row.blockEnd}`;
    const existing = seen.get(key);
    if (!existing || row.score > existing.score) {
      seen.set(key, row);
    }
  }
  const ordered = [...seen.values()].sort((a, b) => b.score - a.score || a.blockStart - b.blockStart);

  return {
    results: ordered.slice(0, limit).map(({ referenceOnly: _referenceOnly, ...row }) => row),
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
  input: { key: string; blockStart: number; blockEnd: number; radius: number },
  overrides: ConfigOverrides = {},
): {
  itemKey: string;
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
  const entries = resolveReadyEntries(input.key, getReadyEntries(catalog));
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
