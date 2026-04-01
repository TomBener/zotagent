import { readFileSync, writeFileSync } from "node:fs";

import type { CatalogCounts, CatalogEntry, CatalogFile } from "./types.js";
import { ensureParentDir, exists } from "./utils.js";

export function readCatalogFile(path: string): CatalogFile {
  if (!exists(path)) {
    return {
      version: 1,
      generatedAt: "",
      entries: [],
    };
  }
  return JSON.parse(readFileSync(path, "utf-8")) as CatalogFile;
}

export function writeCatalogFile(path: string, catalog: CatalogFile): void {
  ensureParentDir(path);
  writeFileSync(path, JSON.stringify(catalog, null, 2), "utf-8");
}

export function summarizeCatalog(catalog: CatalogFile): CatalogCounts {
  const counts: CatalogCounts = {
    totalAttachments: catalog.entries.length,
    supportedAttachments: 0,
    readyAttachments: 0,
    missingAttachments: 0,
    unsupportedAttachments: 0,
    errorAttachments: 0,
  };

  for (const entry of catalog.entries) {
    if (entry.supported) counts.supportedAttachments += 1;
    if (entry.extractStatus === "ready") counts.readyAttachments += 1;
    if (entry.extractStatus === "missing") counts.missingAttachments += 1;
    if (entry.extractStatus === "unsupported") counts.unsupportedAttachments += 1;
    if (entry.extractStatus === "error") counts.errorAttachments += 1;
  }

  return counts;
}

export function mapEntriesByDocKey(catalog: CatalogFile): Map<string, CatalogEntry> {
  return new Map(catalog.entries.map((entry) => [entry.docKey, entry]));
}

export function getReadyEntries(catalog: CatalogFile): CatalogEntry[] {
  return catalog.entries.filter((entry) => entry.extractStatus === "ready");
}
