import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CatalogData } from "./catalog.js";
import { getConfigDir } from "./config.js";
import { exists } from "./utils.js";

const EXCLUDES_FILENAME = "excludes.txt";

export function getExcludesPath(): string {
  return resolve(getConfigDir(), EXCLUDES_FILENAME);
}

// Plain-text format: one itemKey or citationKey per line. Anything from `#`
// to end-of-line is a comment. Blank lines are ignored. The first whitespace-
// separated token on a line is the key; anything after it (before the `#`) is
// also treated as a free-form comment, so notes like:
//
//   Q8FA4UZT  Radkau Nature and Power - per-word fragmentation
//
// work the same as
//
//   Q8FA4UZT  # Radkau Nature and Power - per-word fragmentation
export function loadExcludedKeys(path: string = getExcludesPath()): Set<string> {
  if (!exists(path)) return new Set();
  const content = readFileSync(path, "utf-8");
  const keys = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const commentIndex = rawLine.indexOf("#");
    const beforeComment = commentIndex === -1 ? rawLine : rawLine.slice(0, commentIndex);
    const token = beforeComment.trim().split(/\s+/)[0];
    if (token) keys.add(token);
  }
  return keys;
}

export interface ExcludeFilterStats {
  excludedRecords: number;
  excludedAttachments: number;
  matchedKeys: string[];
  unmatchedKeys: string[];
}

// Filter out bibliography records and attachments whose itemKey or citationKey
// appears in `excludedKeys`. Returns a new CatalogData plus stats so the caller
// can log how many entries were skipped and warn about keys in the exclude file
// that didn't match anything (likely typos or stale entries).
export function applyExcludes(
  catalogData: CatalogData,
  excludedKeys: Set<string>,
): { filtered: CatalogData; stats: ExcludeFilterStats } {
  if (excludedKeys.size === 0) {
    return {
      filtered: catalogData,
      stats: { excludedRecords: 0, excludedAttachments: 0, matchedKeys: [], unmatchedKeys: [] },
    };
  }

  const matched = new Set<string>();

  // Mark every alias of a record that appears in the exclude list, not just
  // the first one we hit. Otherwise `excludes.txt` listing both an itemKey and
  // its citationKey for the same record would warn that the second alias is
  // "unmatched" even though it cleanly identifies the dropped record.
  const filteredRecords = catalogData.records.filter((record) => {
    let drop = false;
    if (excludedKeys.has(record.itemKey)) {
      matched.add(record.itemKey);
      drop = true;
    }
    if (record.citationKey && excludedKeys.has(record.citationKey)) {
      matched.add(record.citationKey);
      drop = true;
    }
    return !drop;
  });

  const filteredAttachments = catalogData.attachments.filter((attachment) => {
    let drop = false;
    if (excludedKeys.has(attachment.itemKey)) {
      matched.add(attachment.itemKey);
      drop = true;
    }
    if (attachment.citationKey && excludedKeys.has(attachment.citationKey)) {
      matched.add(attachment.citationKey);
      drop = true;
    }
    return !drop;
  });

  const unmatchedKeys = [...excludedKeys].filter((key) => !matched.has(key)).sort();

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
