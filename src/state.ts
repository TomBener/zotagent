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

function isInsideDir(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizePathForLookup(candidate);
  const normalizedRoot = normalizePathForLookup(root);
  return normalizedCandidate.startsWith(`${normalizedRoot}/`);
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

  // Cached artifacts that live outside the current dataDir must never be
  // reused: they belong to a different dataDir (e.g. a catalog migrated from
  // another machine or cloned from a backup) and reading from them silently
  // couples two installations. Fall back to the current-dataDir path; the
  // downstream reusability check will decide whether to reuse it or re-extract.
  const normalizedInside = isInsideDir(normalizedPath, dataDir);
  const manifestInside = isInsideDir(manifestPath, dataDir);

  const resolvedNormalizedPath = normalizedInside && exists(normalizedPath)
    ? normalizedPath
    : fallbackNormalizedPath;
  const resolvedManifestPath = manifestInside && exists(manifestPath)
    ? manifestPath
    : fallbackManifestPath;

  return {
    ...entry,
    filePath: replaceForeignHome(entry.filePath),
    ...(entry.normalizedPath ? { normalizedPath: resolvedNormalizedPath } : {}),
    ...(entry.manifestPath ? { manifestPath: resolvedManifestPath } : {}),
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
