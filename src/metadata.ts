import { loadCatalog } from "./catalog.js";
import { getDataPaths, resolveConfig, type ConfigOverrides } from "./config.js";
import { normalizeExactText } from "./exact.js";
import { getReadyEntries, readCatalogFile } from "./state.js";
import type { BibliographyRecord, MetadataField, MetadataSearchResultRow } from "./types.js";
import { compactHomePath } from "./utils.js";

const FIELD_ORDER: MetadataField[] = ["title", "author", "journal", "publisher", "abstract", "year"];
const FIELD_WEIGHTS: Record<MetadataField, number> = {
  title: 6,
  author: 5,
  journal: 4,
  publisher: 4,
  abstract: 3,
  year: 1,
};

interface MetadataSearchOptions {
  fields?: MetadataField[];
  indexed?: boolean;
  includeAbstract?: boolean;
  filters?: Partial<Record<MetadataField, string>>;
  itemKeys?: string[];
}

function includesNormalizedText(text: string | undefined, query: string): boolean {
  if (!text) return false;
  return normalizeExactText(text).includes(query);
}

function matchesAuthor(record: BibliographyRecord, query: string): boolean {
  return record.authorSearchTexts.some((candidate) => includesNormalizedText(candidate, query));
}

function matchesField(record: BibliographyRecord, field: MetadataField, query: string): boolean {
  switch (field) {
    case "title":
      return includesNormalizedText(record.title, query);
    case "author":
      return matchesAuthor(record, query);
    case "year":
      return includesNormalizedText(record.year, query);
    case "abstract":
      return includesNormalizedText(record.abstract, query);
    case "journal":
      return includesNormalizedText(record.journal, query);
    case "publisher":
      return includesNormalizedText(record.publisher, query);
  }
}

function toMetadataSearchResultRow(
  record: BibliographyRecord,
  matchedFields: MetadataField[],
  includeAbstract: boolean,
  indexedFiles: string[],
): MetadataSearchResultRow {
  const score = matchedFields.reduce((total, field) => total + FIELD_WEIGHTS[field], 0);

  return {
    itemKey: record.itemKey,
    ...(record.type ? { type: record.type } : {}),
    title: record.title,
    authors: record.authors,
    ...(record.year ? { year: record.year } : {}),
    ...(includeAbstract && record.abstract ? { abstract: record.abstract } : {}),
    indexed: indexedFiles.length > 0,
    indexedFiles,
    matchedFields,
    score,
    ...(record.journal ? { journal: record.journal } : {}),
    ...(record.publisher ? { publisher: record.publisher } : {}),
  };
}

function sortMetadataResults(
  a: MetadataSearchResultRow,
  b: MetadataSearchResultRow,
): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.indexed !== b.indexed) return Number(b.indexed) - Number(a.indexed);
  const titleCompare = a.title.localeCompare(b.title);
  if (titleCompare !== 0) return titleCompare;
  return a.itemKey.localeCompare(b.itemKey);
}

export async function searchMetadata(
  query: string,
  limit: number,
  overrides: ConfigOverrides = {},
  options: MetadataSearchOptions = {},
): Promise<{
  query: string;
  results: MetadataSearchResultRow[];
  warnings?: string[];
}> {
  const config = resolveConfig(overrides);
  const normalizedQuery = normalizeExactText(query);
  const filterEntries = Object.entries(options.filters ?? {})
    .filter((entry): entry is [MetadataField, string] =>
      typeof entry[1] === "string" && entry[1].length > 0,
    )
    .map(([field, value]) => [field, normalizeExactText(value)] as const)
    .filter(([, normalized]) => normalized.length > 0);
  const hasQuery = normalizedQuery.length > 0;
  const itemKeyFilter = options.itemKeys !== undefined ? new Set(options.itemKeys) : undefined;
  const hasFilters = filterEntries.length > 0 || itemKeyFilter !== undefined;

  if (!hasQuery && !hasFilters) {
    throw new Error("Metadata search requires a query or at least one field filter.");
  }

  const selectedFields = new Set(options.fields ?? FIELD_ORDER);
  const includeAbstract = options.includeAbstract ?? false;
  const filterFieldSet = new Set(filterEntries.map(([field]) => field));
  const { records } = loadCatalog(config);
  // Indexed status comes from the shared index catalog, not from resolving
  // bibliography file paths against the local attachmentsRoot — the index is
  // what search-in/fulltext actually read, and it stays correct on devices
  // that hold the index but not the attachment files themselves.
  const catalogPath = getDataPaths(config.dataDir).catalogPath;
  const indexCatalog = readCatalogFile(catalogPath);
  const indexedFilesByItemKey = new Map<string, string[]>();
  for (const entry of getReadyEntries(indexCatalog)) {
    const files = indexedFilesByItemKey.get(entry.itemKey) ?? [];
    files.push(compactHomePath(entry.filePath));
    indexedFilesByItemKey.set(entry.itemKey, files);
  }
  const warnings: string[] = [...config.warnings];
  if (records.length > 0 && indexedFilesByItemKey.size === 0) {
    warnings.push(
      `Full-text index catalog at ${compactHomePath(catalogPath)} is missing or has no ready entries; every result reports indexed: false. Run \`zotagent sync\` where the index is built, or re-copy the index directory onto this device.`,
    );
  }
  if (itemKeyFilter !== undefined && itemKeyFilter.size > 0) {
    const knownItemKeys = new Set(
      records.filter((record) => itemKeyFilter.has(record.itemKey)).map((record) => record.itemKey),
    );
    const missing = itemKeyFilter.size - knownItemKeys.size;
    if (missing > 0) {
      warnings.push(
        `${missing} of ${itemKeyFilter.size} matched item${itemKeyFilter.size === 1 ? "" : "s"} ${missing === 1 ? "is" : "are"} missing from the bibliography; re-export bibliographyJsonPath to include ${missing === 1 ? "it" : "them"}.`,
      );
    }
  }
  const results = records
    .filter((record) => !itemKeyFilter || itemKeyFilter.has(record.itemKey))
    .filter((record) => !options.indexed || indexedFilesByItemKey.has(record.itemKey))
    .filter((record) =>
      filterEntries.every(([field, normalized]) => matchesField(record, field, normalized)),
    )
    .map((record) => {
      const queryMatched = hasQuery
        ? FIELD_ORDER.filter(
            (field) => selectedFields.has(field) && matchesField(record, field, normalizedQuery),
          )
        : [];
      if (hasQuery && queryMatched.length === 0) return null;
      const matchedFields = FIELD_ORDER.filter(
        (field) => queryMatched.includes(field) || filterFieldSet.has(field),
      );
      return toMetadataSearchResultRow(
        record,
        matchedFields,
        includeAbstract,
        indexedFilesByItemKey.get(record.itemKey) ?? [],
      );
    })
    .filter((result): result is MetadataSearchResultRow => result !== null)
    .sort(sortMetadataResults)
    .slice(0, limit);

  return {
    query,
    results,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
