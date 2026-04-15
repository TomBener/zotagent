import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import type { CatalogCounts, CatalogEntry, CatalogFile } from "./types.js";
import { MANIFEST_EXT, assertManifestsCurrent, compactHomePath, ensureParentDir, exists, normalizePathForLookup, resolveManifestPath } from "./utils.js";

function dataDirFromCatalogPath(path: string): string {
  return dirname(dirname(normalizePathForLookup(path)));
}

function replaceForeignHome(path: string): string {
  const normalized = normalizePathForLookup(path);
  const currentHome = normalizePathForLookup(homedir());
  if (normalized.startsWith(`${currentHome}/`)) return normalized;

  const replaced = normalized.replace(/^\/Users\/[^/]+/u, currentHome);
  return replaced !== normalized && exists(replaced) ? replaced : normalized;
}

function hydrateCatalogEntry(entry: CatalogEntry, dataDir: string): CatalogEntry {
  const normalizedPath = entry.normalizedPath
    ? replaceForeignHome(entry.normalizedPath)
    : resolve(dataDir, "normalized", `${entry.docKey}.md`);
  const manifestPath = entry.manifestPath
    ? resolveManifestPath(replaceForeignHome(entry.manifestPath))
    : resolve(dataDir, "manifests", `${entry.docKey}${MANIFEST_EXT}`);

  const fallbackNormalizedPath = resolve(dataDir, "normalized", `${entry.docKey}.md`);
  const fallbackManifestPath = resolve(dataDir, "manifests", `${entry.docKey}${MANIFEST_EXT}`);

  return {
    ...entry,
    filePath: replaceForeignHome(entry.filePath),
    ...(entry.normalizedPath
      ? { normalizedPath: exists(normalizedPath) ? normalizedPath : fallbackNormalizedPath }
      : {}),
    ...(entry.manifestPath ? { manifestPath: exists(manifestPath) ? manifestPath : fallbackManifestPath } : {}),
  };
}

function compactCatalogEntry(entry: CatalogEntry): CatalogEntry {
  return {
    ...entry,
    filePath: compactHomePath(entry.filePath),
    ...(entry.normalizedPath ? { normalizedPath: compactHomePath(entry.normalizedPath) } : {}),
    ...(entry.manifestPath ? { manifestPath: compactHomePath(entry.manifestPath) } : {}),
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
  const catalog = JSON.parse(readFileSync(catalogPath, "utf-8")) as CatalogFile;
  const dataDir = dataDirFromCatalogPath(catalogPath);
  assertManifestsCurrent(resolve(dataDir, "manifests"));
  return {
    ...catalog,
    entries: catalog.entries.map((entry) => hydrateCatalogEntry(entry, dataDir)),
  };
}

export function writeCatalogFile(path: string, catalog: CatalogFile): void {
  const catalogPath = normalizePathForLookup(path);
  ensureParentDir(catalogPath);
  writeFileSync(
    catalogPath,
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
