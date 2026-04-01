import { readFileSync } from "node:fs";

import { getDataPaths, resolveConfig, type ConfigOverrides } from "./config.js";
import { openQmdClient, type QmdFactory } from "./qmd.js";
import { getReadyEntries, readCatalogFile, summarizeCatalog } from "./state.js";
import type { AttachmentManifest, CatalogEntry, SearchResultRow } from "./types.js";
import { compactHomePath, exists, normalizePathForLookup, overlap } from "./utils.js";

interface SearchBehaviorOptions {
  rerank?: boolean;
  minScore?: number;
  exact?: boolean;
}

function readManifest(path: string): AttachmentManifest {
  return JSON.parse(readFileSync(path, "utf-8")) as AttachmentManifest;
}

function resolveReadyEntry(
  fileOrItem: { file?: string; itemKey?: string },
  entries: CatalogEntry[],
): CatalogEntry {
  if (fileOrItem.file) {
    const normalized = normalizePathForLookup(fileOrItem.file);
    const matched = entries.find((entry) => normalizePathForLookup(entry.filePath) === normalized);
    if (!matched) {
      throw new Error(`Indexed attachment not found for file: ${fileOrItem.file}`);
    }
    return matched;
  }

  if (fileOrItem.itemKey) {
    const matched = entries.filter((entry) => entry.itemKey === fileOrItem.itemKey);
    if (matched.length === 0) {
      throw new Error(`No indexed attachment found for itemKey: ${fileOrItem.itemKey}`);
    }
    if (matched.length > 1) {
      throw new Error(
        JSON.stringify({
          message: `Multiple indexed attachments found for itemKey: ${fileOrItem.itemKey}`,
          files: matched.map((entry) => compactHomePath(entry.filePath)),
        }),
      );
    }
    return matched[0]!;
  }

  throw new Error("Provide either --file or --item-key.");
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

function buildExactLexQuery(query: string): string {
  const phrase = query.replace(/"/gu, " ").replace(/\s+/gu, " ").trim();
  if (phrase.length === 0) {
    throw new Error("Exact search text cannot be empty.");
  }
  return `"${phrase}"`;
}

function normalizeExactText(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function findExactPhraseBlockRange(
  manifest: AttachmentManifest,
  query: string,
): { blockStart: number; blockEnd: number } | null {
  const normalizedQuery = normalizeExactText(query);
  if (normalizedQuery.length === 0) return null;

  const normalizedBlocks = manifest.blocks.map((block) => ({
    blockIndex: block.blockIndex,
    text: normalizeExactText(block.text),
  }));

  let best: { blockStart: number; blockEnd: number; span: number } | null = null;

  for (let start = 0; start < normalizedBlocks.length; start++) {
    let combined = "";
    for (let end = start; end < normalizedBlocks.length; end++) {
      const text = normalizedBlocks[end]!.text;
      combined = combined.length > 0 ? `${combined} ${text}`.trim() : text;
      if (combined.length === 0) continue;
      if (!combined.includes(normalizedQuery)) continue;

      const candidate = {
        blockStart: normalizedBlocks[start]!.blockIndex,
        blockEnd: normalizedBlocks[end]!.blockIndex,
        span: end - start,
      };
      if (!best || candidate.span < best.span) {
        best = candidate;
      }
      break;
    }
  }

  return best ? { blockStart: best.blockStart, blockEnd: best.blockEnd } : null;
}

export async function searchLiterature(
  query: string,
  limit: number,
  overrides: ConfigOverrides = {},
  qmdFactory: QmdFactory = openQmdClient,
  behavior: SearchBehaviorOptions = {},
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
  const qmd = await qmdFactory(config);
  try {
    const mapped = behavior.exact
      ? (
          await qmd.searchLex(buildExactLexQuery(query), { limit })
        )
          .filter((result) => behavior.minScore === undefined || result.score >= behavior.minScore)
          .map((result) => {
            const docKey =
              docKeyFromSearchResultPath(result.filepath) ?? docKeyFromSearchResultPath(result.displayPath);
            if (!docKey) return null;
            const entry = entryByDocKey.get(docKey);
            if (!entry || !entry.manifestPath || !exists(entry.manifestPath)) return null;
            const manifest = readManifest(entry.manifestPath);
            const range = findExactPhraseBlockRange(manifest, query);
            if (!range) return null;
            return buildSearchRow(entry, manifest, range, result.score);
          })
          .filter((value): value is ReturnType<typeof buildSearchRow> => value !== null)
          .sort((a, b) => b.score - a.score)
      : (
          await qmd.search({
            query,
            limit,
            ...(behavior.rerank !== undefined ? { rerank: behavior.rerank } : {}),
            ...(behavior.minScore !== undefined ? { minScore: behavior.minScore } : {}),
          })
        )
          .map((result) => {
            const docKey = docKeyFromSearchResultPath(result.file) ?? docKeyFromSearchResultPath(result.displayPath);
            if (!docKey) return null;
            const entry = entryByDocKey.get(docKey);
            if (!entry || !entry.manifestPath || !exists(entry.manifestPath)) return null;
            const manifest = readManifest(entry.manifestPath);
            return buildHybridSearchRow(entry, manifest, result);
          })
          .filter((value): value is ReturnType<typeof buildHybridSearchRow> => value !== null)
          .sort((a, b) => b.score - a.score);

    const substantive = mapped.filter((row) => !row.referenceOnly);
    const references = mapped.filter((row) => row.referenceOnly);
    const ordered = substantive.length > 0 ? [...substantive, ...references] : mapped;

    return {
      results: ordered.slice(0, limit).map(({ referenceOnly: _referenceOnly, ...row }) => row),
      ...(config.warnings.length > 0 ? { warnings: config.warnings } : {}),
    };
  } finally {
    await qmd.close();
  }
}

export function readDocument(
  input: { file?: string; itemKey?: string; offsetBlock: number; limitBlocks: number },
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

export function expandDocument(
  input: { file: string; blockStart: number; blockEnd: number; radius: number },
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
  const entry = resolveReadyEntry({ file: input.file }, getReadyEntries(catalog));
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
