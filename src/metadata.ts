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
): MetadataSearchResultRow {
  const score = matchedFields.reduce((total, field) => total + FIELD_WEIGHTS[field], 0);

  return {
    itemKey: record.itemKey,
    ...(record.citationKey ? { citationKey: record.citationKey } : {}),
    ...(record.type ? { type: record.type } : {}),
    title: record.title,
    authors: record.authors,
    ...(record.year ? { year: record.year } : {}),
    ...(record.abstract ? { abstract: record.abstract } : {}),
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
  if (normalizedQuery.length === 0) {
    throw new Error("Metadata search text cannot be empty.");
  }

  const selectedFields = new Set(options.fields ?? FIELD_ORDER);
  const { records } = loadCatalog(config);
  const results = records
    .filter((record) => !options.hasFile || record.hasSupportedFile)
    .map((record) => {
      const matchedFields = FIELD_ORDER.filter(
        (field) => selectedFields.has(field) && matchesField(record, field, normalizedQuery),
      );
      if (matchedFields.length === 0) return null;
      return toMetadataSearchResultRow(record, matchedFields);
    })
    .filter((result): result is MetadataSearchResultRow => result !== null)
    .sort(sortMetadataResults)
    .slice(0, limit);

  return {
    results,
    ...(config.warnings.length > 0 ? { warnings: config.warnings } : {}),
  };
}
