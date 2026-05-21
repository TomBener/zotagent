import type { CatalogData } from "./catalog.js";

export interface ExcludeFilterStats {
  excludedRecords: number;
  excludedAttachments: number;
  matchedKeys: string[];
  unmatchedKeys: string[];
}

// Filter out bibliography records and attachments whose itemKey appears in
// `excludedItemKeys`. The set is populated from a Zotero tag at sync start —
// see resolveExcludedItemKeys in sync.ts. Returns a new CatalogData plus
// stats so the caller can log how many entries were skipped and warn about
// keys that didn't match anything (typically items the user has tagged in
// Zotero but whose attachments aren't in the bibliography export yet).
export function applyExcludes(
  catalogData: CatalogData,
  excludedItemKeys: ReadonlySet<string>,
): { filtered: CatalogData; stats: ExcludeFilterStats } {
  if (excludedItemKeys.size === 0) {
    return {
      filtered: catalogData,
      stats: { excludedRecords: 0, excludedAttachments: 0, matchedKeys: [], unmatchedKeys: [] },
    };
  }

  const matched = new Set<string>();

  const filteredRecords = catalogData.records.filter((record) => {
    if (excludedItemKeys.has(record.itemKey)) {
      matched.add(record.itemKey);
      return false;
    }
    return true;
  });

  const filteredAttachments = catalogData.attachments.filter((attachment) => {
    if (excludedItemKeys.has(attachment.itemKey)) {
      matched.add(attachment.itemKey);
      return false;
    }
    return true;
  });

  const unmatchedKeys = [...excludedItemKeys].filter((key) => !matched.has(key)).sort();

  return {
    filtered: { records: filteredRecords, attachments: filteredAttachments },
    stats: {
      excludedRecords: catalogData.records.length - filteredRecords.length,
      excludedAttachments: catalogData.attachments.length - filteredAttachments.length,
      matchedKeys: [...matched].sort(),
      unmatchedKeys,
    },
  };
}
