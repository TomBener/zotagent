import { readFileSync } from "node:fs";

import { getDataPaths, resolveConfig, type ConfigOverrides } from "./config.js";
import { findExactPhraseBlockRange, normalizeExactText } from "./exact.js";
import { isBoilerplateLikeText, isTableOfContentsLikeText } from "./heuristics.js";
import { openQmdClient, type QmdFactory } from "./qmd.js";
import { getReadyEntries, readCatalogFile, summarizeCatalog } from "./state.js";
import { openExactIndex, type ExactIndexFactory } from "./exact-db.js";
import type { AttachmentManifest, CatalogEntry, ManifestBlock, SearchResultRow } from "./types.js";
import { cleanText, compactHomePath, exists, normalizePathForLookup, overlap } from "./utils.js";

interface SearchBehaviorOptions {
  rerank?: boolean;
  minScore?: number;
  exact?: boolean;
  progress?: (message: string) => void;
}

function readManifest(path: string): AttachmentManifest {
  return JSON.parse(readFileSync(path, "utf-8")) as AttachmentManifest;
}

function resolveReadyEntries(
  fileOrItem: { file?: string; itemKey?: string; citationKey?: string },
  entries: CatalogEntry[],
  options: { allowMultipleMatches?: boolean } = {},
): CatalogEntry[] {
  const selectors = [
    fileOrItem.file ? "--file <path>" : null,
    fileOrItem.itemKey ? "--item-key <key>" : null,
    fileOrItem.citationKey ? "--citation-key <key>" : null,
  ].filter((value): value is string => value !== null);

  if (selectors.length > 1) {
    throw new Error(
      "Provide exactly one of --file <path>, --item-key <key>, or --citation-key <key>.",
    );
  }

  if (fileOrItem.file) {
    const normalized = normalizePathForLookup(fileOrItem.file);
    const matched = entries.find((entry) => normalizePathForLookup(entry.filePath) === normalized);
    if (!matched) {
      throw new Error(`Indexed attachment not found for file: ${fileOrItem.file}`);
    }
    return [matched];
  }

  if (fileOrItem.itemKey) {
    const matched = entries.filter((entry) => entry.itemKey === fileOrItem.itemKey);
    if (matched.length === 0) {
      throw new Error(`No indexed attachment found for itemKey: ${fileOrItem.itemKey}`);
    }
    if (matched.length > 1 && !options.allowMultipleMatches) {
      throw new Error(
        JSON.stringify({
          message: `Multiple indexed attachments found for itemKey: ${fileOrItem.itemKey}`,
          files: matched.map((entry) => compactHomePath(entry.filePath)),
        }),
      );
    }
    return matched;
  }

  if (fileOrItem.citationKey) {
    const matched = entries.filter((entry) => entry.citationKey === fileOrItem.citationKey);
    if (matched.length === 0) {
      throw new Error(`No indexed attachment found for citationKey: ${fileOrItem.citationKey}`);
    }
    if (matched.length > 1 && !options.allowMultipleMatches) {
      throw new Error(
        JSON.stringify({
          message: `Multiple indexed attachments found for citationKey: ${fileOrItem.citationKey}`,
          files: matched.map((entry) => compactHomePath(entry.filePath)),
        }),
      );
    }
    return matched;
  }

  throw new Error("Provide one of --file <path>, --item-key <key>, or --citation-key <key>.");
}

function resolveReadyEntry(
  fileOrItem: { file?: string; itemKey?: string; citationKey?: string },
  entries: CatalogEntry[],
): CatalogEntry {
  return resolveReadyEntries(fileOrItem, entries)[0]!;
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
  score: number,
): SearchResultRow & { referenceOnly: boolean } {
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
    file: compactHomePath(entry.filePath),
    passage: blocks.map((block) => block.text).join("\n\n"),
    blockStart: range.blockStart,
    blockEnd: range.blockEnd,
    score: Math.round((score - (referenceOnly ? 0.05 : 0)) * 10000) / 10000,
    referenceOnly,
  };
}

function buildHybridSearchRow(
  entry: CatalogEntry,
  manifest: AttachmentManifest,
  result: { bestChunkPos: number; bestChunk: string; score: number },
): SearchResultRow & { referenceOnly: boolean } {
  const range = mapChunkToBlockRange(manifest, result.bestChunkPos, result.bestChunk);
  return buildSearchRow(entry, manifest, range, result.score);
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
  file: string;
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
  exactFactory: ExactIndexFactory = openExactIndex,
): Promise<{
  results: SearchResultRow[];
  warnings?: string[];
}> {
  const config = resolveConfig(overrides);
  const paths = getDataPaths(config.dataDir);
  const catalog = readCatalogFile(paths.catalogPath);
  const readyEntries = getReadyEntries(catalog);
  if (readyEntries.length === 0) {
    throw new Error("No indexed PDFs found. Run `zotlit sync` first.");
  }

  const entryByDocKey = new Map(readyEntries.map((entry) => [entry.docKey, entry]));
  const mapped = behavior.exact
    ? await (async () => {
        const exactIndex = await exactFactory(config);
        try {
          return (
            await exactIndex.searchExactCandidates(query, limit)
          )
            .filter((candidate) => behavior.minScore === undefined || candidate.score >= behavior.minScore)
            .map((candidate) => {
              const entry = entryByDocKey.get(candidate.docKey);
              if (!entry || !entry.manifestPath || !exists(entry.manifestPath)) return null;
              const manifest = readManifest(entry.manifestPath);
              const range = findExactPhraseBlockRange(manifest, query);
              if (!range) return null;
              return buildSearchRow(entry, manifest, range, candidate.score);
            })
            .filter((value): value is ReturnType<typeof buildSearchRow> => value !== null)
            .sort((a, b) => b.score - a.score);
        } finally {
          await exactIndex.close();
        }
      })()
    : await (async () => {
        const qmd = await qmdFactory(config);
        try {
          const rerank = behavior.rerank ?? false;
          behavior.progress?.(
            rerank
              ? "qmd search: running hybrid query with rerank"
              : "qmd search: running hybrid query without rerank",
          );
          return (
            await qmd.search({
              query,
              limit,
              rerank,
              ...(behavior.minScore !== undefined ? { minScore: behavior.minScore } : {}),
            })
          )
            .map((result) => {
              const docKey =
                docKeyFromSearchResultPath(result.file) ?? docKeyFromSearchResultPath(result.displayPath);
              if (!docKey) return null;
              const entry = entryByDocKey.get(docKey);
              if (!entry || !entry.manifestPath || !exists(entry.manifestPath)) return null;
              const manifest = readManifest(entry.manifestPath);
              return buildHybridSearchRow(entry, manifest, result);
            })
            .filter((value): value is ReturnType<typeof buildHybridSearchRow> => value !== null)
            .sort((a, b) => b.score - a.score);
        } finally {
          await qmd.close();
        }
      })();

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
  input: { file?: string; itemKey?: string; citationKey?: string },
  limit: number,
  overrides: ConfigOverrides = {},
): {
  results: SearchResultRow[];
  warnings: string[];
} {
  const normalizedQuery = normalizeExactText(query);
  if (!normalizedQuery) {
    throw new Error("Missing search text. Use: zotlit search-in \"<text>\" (--file <path> | --item-key <key> | --citation-key <key>)");
  }

  const queryTerms = [...new Set(normalizedQuery.split(" ").filter((term) => term.length > 0))];
  const config = resolveConfig(overrides);
  const catalog = readCatalogFile(getDataPaths(config.dataDir).catalogPath);
  const entries = resolveReadyEntries(input, getReadyEntries(catalog), { allowMultipleMatches: true });
  const mapped: Array<SearchResultRow & { referenceOnly: boolean }> = [];

  for (const entry of entries) {
    if (!entry.manifestPath || !exists(entry.manifestPath)) {
      throw new Error(`Indexed manifest not found for file: ${entry.filePath}`);
    }

    const manifest = readManifest(entry.manifestPath);
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

    mapped.push(
      ...[...candidates.values()]
        .sort((a, b) => b.score - a.score || a.range.blockStart - b.range.blockStart)
        .map((candidate) => buildSearchRow(entry, manifest, candidate.range, candidate.score)),
    );
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
  input: { file?: string; itemKey?: string; citationKey?: string; offsetBlock: number; limitBlocks: number },
  overrides: ConfigOverrides = {},
): {
  itemKey: string;
  citationKey?: string;
  title: string;
  authors: string[];
  year?: string;
  file: string;
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
  const entry = resolveReadyEntry(input, getReadyEntries(catalog));
  if (!entry.manifestPath || !exists(entry.manifestPath)) {
    throw new Error(`Indexed manifest not found for file: ${entry.filePath}`);
  }
  const manifest = readManifest(entry.manifestPath);
  const blocks = manifest.blocks.slice(input.offsetBlock, input.offsetBlock + input.limitBlocks);
  return {
    itemKey: entry.itemKey,
    ...(entry.citationKey ? { citationKey: entry.citationKey } : {}),
    title: entry.title,
    authors: entry.authors,
    ...(entry.year ? { year: entry.year } : {}),
    file: compactHomePath(entry.filePath),
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
  entry: CatalogEntry,
  options: { clean?: boolean } = {},
): FullTextRow {
  if (!entry.manifestPath || !exists(entry.manifestPath)) {
    throw new Error(`Indexed manifest not found for file: ${entry.filePath}`);
  }

  const manifest = readManifest(entry.manifestPath);
  if (!options.clean) {
    let content = "";
    let source: "manifest" | "normalized" = "manifest";

    if (entry.normalizedPath && exists(entry.normalizedPath)) {
      content = cleanText(readFileSync(entry.normalizedPath, "utf-8"));
      source = "normalized";
    } else {
      content = renderManifestMarkdown(manifest);
    }

    if (!content) {
      throw new Error(`No readable full text found for file: ${entry.filePath}`);
    }

    return {
      itemKey: entry.itemKey,
      ...(entry.citationKey ? { citationKey: entry.citationKey } : {}),
      title: entry.title,
      authors: entry.authors,
      ...(entry.year ? { year: entry.year } : {}),
      file: compactHomePath(entry.filePath),
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

    const looksLikeBoilerplate = options.clean
      && (
        isBoilerplateLikeText(text)
        || (block.blockIndex < earlyNoiseWindow && isTableOfContentsLikeText(text))
      );
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

  let content = cleanText(snippets.join("\n\n"));
  let source: "manifest" | "normalized" = "manifest";
  if (!content && entry.normalizedPath && exists(entry.normalizedPath)) {
    content = cleanText(readFileSync(entry.normalizedPath, "utf-8"));
    source = "normalized";
  }
  if (!content) {
    throw new Error(`No readable full text found for file: ${entry.filePath}`);
  }

  return {
    itemKey: entry.itemKey,
    ...(entry.citationKey ? { citationKey: entry.citationKey } : {}),
    title: entry.title,
    authors: entry.authors,
    ...(entry.year ? { year: entry.year } : {}),
    file: compactHomePath(entry.filePath),
    format: "markdown",
    source,
    totalBlocks: manifest.blocks.length,
    keptBlocks: snippets.length,
    skippedBoilerplateBlocks,
    skippedDuplicateBlocks,
    content,
  };
}

export function fullTextDocuments(
  input: { file?: string; itemKey?: string; citationKey?: string; clean?: boolean },
  overrides: ConfigOverrides = {},
): {
  results: FullTextRow[];
  warnings: string[];
} {
  const config = resolveConfig(overrides);
  const catalog = readCatalogFile(getDataPaths(config.dataDir).catalogPath);
  const entries = resolveReadyEntries(input, getReadyEntries(catalog), { allowMultipleMatches: true });

  return {
    results: entries.map((entry) => buildFullTextRow(entry, { clean: input.clean })),
    warnings: config.warnings,
  };
}

export function fullTextDocument(
  input: { file?: string; itemKey?: string; citationKey?: string; clean?: boolean },
  overrides: ConfigOverrides = {},
): FullTextRow {
  return fullTextDocuments(input, overrides).results[0]!;
}

export function expandDocument(
  input: { file?: string; itemKey?: string; citationKey?: string; blockStart: number; blockEnd: number; radius: number },
  overrides: ConfigOverrides = {},
): {
  itemKey: string;
  citationKey?: string;
  title: string;
  authors: string[];
  year?: string;
  file: string;
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
  const entry = resolveReadyEntry(
    { file: input.file, itemKey: input.itemKey, citationKey: input.citationKey },
    getReadyEntries(catalog),
  );
  if (!entry.manifestPath || !exists(entry.manifestPath)) {
    throw new Error(`Indexed manifest not found for file: ${entry.filePath}`);
  }
  const manifest = readManifest(entry.manifestPath);
  const contextStart = Math.max(0, input.blockStart - input.radius);
  const contextEnd = Math.min(manifest.blocks.length - 1, input.blockEnd + input.radius);
  const blocks = manifest.blocks.filter(
    (block) => block.blockIndex >= contextStart && block.blockIndex <= contextEnd,
  );
  const passageBlocks = blocks.filter(
    (block) => block.blockIndex >= input.blockStart && block.blockIndex <= input.blockEnd,
  );

  return {
    itemKey: entry.itemKey,
    ...(entry.citationKey ? { citationKey: entry.citationKey } : {}),
    title: entry.title,
    authors: entry.authors,
    ...(entry.year ? { year: entry.year } : {}),
    file: compactHomePath(entry.filePath),
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
