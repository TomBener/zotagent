import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCatalogFile, writeCatalogFile } from "../../src/state.js";
import type { CatalogEntry, CatalogFile } from "../../src/types.js";

function tempIndexDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "zotagent-state-"));
  return join(dataDir, "index");
}

function sampleEntry(docKey: string): CatalogEntry {
  return {
    docKey,
    itemKey: `ITEM-${docKey}`,
    title: `Title ${docKey}`,
    authors: ["A"],
    filePath: `/tmp/${docKey}.pdf`,
    fileExt: "pdf",
    exists: true,
    supported: true,
    extractStatus: "ready",
    size: 1,
    mtimeMs: 1,
    sourceHash: `${docKey}-hash`,
    lastIndexedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("writeCatalogFile then readCatalogFile round-trips entries", () => {
  const indexDir = tempIndexDir();
  const catalogPath = join(indexDir, "catalog.json");
  const catalog: CatalogFile = {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    entries: [sampleEntry("DOC1"), sampleEntry("DOC2")],
  };

  writeCatalogFile(catalogPath, catalog);
  const read = readCatalogFile(catalogPath);

  assert.equal(read.version, 1);
  assert.equal(read.generatedAt, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(read.entries, catalog.entries);
});

test("writeCatalogFile leaves no .tmp residue and produces parseable JSON", () => {
  const indexDir = tempIndexDir();
  const catalogPath = join(indexDir, "catalog.json");

  writeCatalogFile(catalogPath, {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    entries: [sampleEntry("DOC1")],
  });

  assert.equal(existsSync(`${catalogPath}.tmp`), false);
  const parsed = JSON.parse(readFileSync(catalogPath, "utf-8")) as CatalogFile;
  assert.equal(parsed.entries.length, 1);
});

test("readCatalogFile degrades to an empty catalog and preserves a corrupt file", () => {
  const indexDir = tempIndexDir();
  const catalogPath = join(indexDir, "catalog.json");

  // First write a valid catalog so the index dir exists, then clobber it with
  // a truncated fragment that JSON.parse cannot accept.
  writeCatalogFile(catalogPath, {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    entries: [sampleEntry("DOC1")],
  });
  writeFileSync(catalogPath, '{"version":1,"generatedAt":"', "utf-8");

  const read = readCatalogFile(catalogPath);

  assert.deepEqual(read, { version: 1, generatedAt: "", entries: [] });
  assert.equal(existsSync(`${catalogPath}.corrupt`), true);
});

test("readCatalogFile on a missing file returns the empty catalog", () => {
  const indexDir = tempIndexDir();
  const catalogPath = join(indexDir, "catalog.json");

  const read = readCatalogFile(catalogPath);

  assert.deepEqual(read, { version: 1, generatedAt: "", entries: [] });
});
