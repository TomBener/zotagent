import { loadCatalog } from "./catalog.js";
import { resolveConfig, type ConfigOverrides } from "./config.js";
import { normalizeExactText } from "./exact.js";
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
  hasFile?: boolean;
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
): MetadataSearchResultRow {
  const score = matchedFields.reduce((total, field) => total + FIELD_WEIGHTS[field], 0);

  return {
    itemKey: record.itemKey,
    ...(record.type ? { type: record.type } : {}),
    title: record.title,
    authors: record.authors,
    ...(record.year ? { year: record.year } : {}),
    ...(includeAbstract && record.abstract ? { abstract: record.abstract } : {}),
    hasSupportedFile: record.hasSupportedFile,
    supportedFiles: record.supportedFiles.map((filePath) => compactHomePath(filePath)),
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
  if (a.hasSupportedFile !== b.hasSupportedFile) return Number(b.hasSupportedFile) - Number(a.hasSupportedFile);
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
  const warnings: string[] = [...config.warnings];
  if (itemKeyFilter !== undefined && itemKeyFilter.size > 0) {
    const knownItemKeys = new Set(
      records.filter((record) => itemKeyFilter.has(record.itemKey)).map((record) => record.itemKey),
    );
    const missing = itemKeyFilter.size - knownItemKeys.size;
    if (missing > 0) {
      warnings.push(
        `${missing} of ${itemKeyFilter.size} tag-matched item${itemKeyFilter.size === 1 ? "" : "s"} ${missing === 1 ? "is" : "are"} missing from the bibliography; re-export bibliographyJsonPath to include ${missing === 1 ? "it" : "them"}.`,
      );
    }
  }
  const results = records
    .filter((record) => !itemKeyFilter || itemKeyFilter.has(record.itemKey))
    .filter((record) => !options.hasFile || record.hasSupportedFile)
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
      return toMetadataSearchResultRow(record, matchedFields, includeAbstract);
    })
    .filter((result): result is MetadataSearchResultRow => result !== null)
    .sort(sortMetadataResults)
    .slice(0, limit);

  return {
    results,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
