import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import type { CatalogCounts, CatalogEntry, CatalogFile } from "./types.js";
import { compactHomePath, ensureParentDir, exists, normalizePathForLookup } from "./utils.js";

function replaceForeignHome(path: string): string {
  const normalized = normalizePathForLookup(path);
  const currentHome = normalizePathForLookup(homedir());
  if (normalized.startsWith(`${currentHome}/`)) return normalized;

  const replaced = normalized.replace(/^\/Users\/[^/]+/u, currentHome);
  return replaced !== normalized && exists(replaced) ? replaced : normalized;
}

// Older catalogs stored normalizedPath/manifestPath per entry. The artifact
// store derives both from docKey, so the fields carry no information — strip
// them on read (the next write simply omits them).
function hydrateCatalogEntry(entry: CatalogEntry): CatalogEntry {
  const { normalizedPath: _n, manifestPath: _m, ...rest } = entry as CatalogEntry & {
    normalizedPath?: string;
    manifestPath?: string;
  };
  return {
    ...rest,
    filePath: replaceForeignHome(entry.filePath),
  };
}

function compactCatalogEntry(entry: CatalogEntry): CatalogEntry {
  return {
    ...entry,
    filePath: compactHomePath(entry.filePath),
  };
}

export function readCatalogFile(path: string): CatalogFile {
  const catalogPath = normalizePathForLookup(path);
  if (!exists(catalogPath)) {
    return {
      version: 1,
      generatedAt: "",
      entries: [],
    };
  }
  let catalog: CatalogFile;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, "utf-8")) as CatalogFile;
  } catch {
    // Corrupt/truncated catalog (e.g. a crash mid-write): move the evidence
    // aside so the next write starts clean, then degrade to an empty catalog.
    // Sync treats this the same as "never indexed" and performs a full
    // rebuild, so the tool self-heals instead of throwing on every command.
    try {
      renameSync(catalogPath, `${catalogPath}.corrupt`);
    } catch {
      // If the rename itself fails, fall through with the empty catalog.
    }
    return {
      version: 1,
      generatedAt: "",
      entries: [],
    };
  }
  return {
    ...catalog,
    entries: catalog.entries.map(hydrateCatalogEntry),
  };
}

export function writeCatalogFile(path: string, catalog: CatalogFile): void {
  const catalogPath = normalizePathForLookup(path);
  ensureParentDir(catalogPath);
  const tmp = `${catalogPath}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify(
      {
        ...catalog,
        entries: catalog.entries.map(compactCatalogEntry),
      },
      null,
      2,
    ),
    "utf-8",
  );
  renameSync(tmp, catalogPath);
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
