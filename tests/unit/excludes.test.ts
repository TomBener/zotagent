import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CatalogData } from "../../src/catalog.js";
import { applyExcludes, loadExcludedKeys } from "../../src/excludes.js";
import type { AttachmentCatalogEntry, BibliographyRecord } from "../../src/types.js";

function makeRecord(itemKey: string, citationKey?: string): BibliographyRecord {
  return {
    itemKey,
    ...(citationKey ? { citationKey } : {}),
    title: `${itemKey} title`,
    authors: ["A"],
    authorSearchTexts: ["a"],
    attachmentPaths: [],
    supportedFiles: [],
    hasSupportedFile: false,
  };
}

function makeAttachment(itemKey: string, citationKey: string | undefined, filePath: string): AttachmentCatalogEntry {
  return {
    docKey: `dock-${itemKey}-${filePath}`,
    itemKey,
    ...(citationKey ? { citationKey } : {}),
    title: `${itemKey} title`,
    authors: ["A"],
    filePath,
    fileExt: "pdf",
    exists: true,
    supported: true,
  };
}

test("loadExcludedKeys returns an empty set when the file is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-excludes-missing-"));
  const path = join(root, "does-not-exist.txt");
  assert.equal(loadExcludedKeys(path).size, 0);
});

test("loadExcludedKeys parses keys with comments, blanks, and free-form notes", () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-excludes-parse-"));
  const path = join(root, "excludes.txt");
  writeFileSync(
    path,
    [
      "# Top-of-file comment",
      "",
      "Q8FA4UZT  # Radkau, picture book",
      "NZ4AAR5C    余英時 vertical CJK",
      "  ",
      "  NTRDQXNI",
      "# trailing comment",
      "lee2024party",
      "DUPLICATE   first occurrence",
      "DUPLICATE   second occurrence — set should dedupe",
    ].join("\n"),
    "utf-8",
  );
  const keys = loadExcludedKeys(path);
  assert.deepEqual(
    [...keys].sort(),
    ["DUPLICATE", "NTRDQXNI", "NZ4AAR5C", "Q8FA4UZT", "lee2024party"].sort(),
  );
});

test("applyExcludes is a no-op when the exclusion set is empty", () => {
  const data: CatalogData = {
    records: [makeRecord("AAAAAAAA")],
    attachments: [makeAttachment("AAAAAAAA", undefined, "/tmp/a.pdf")],
  };
  const { filtered, stats } = applyExcludes(data, new Set());
  assert.equal(filtered, data);
  assert.equal(stats.excludedRecords, 0);
  assert.equal(stats.excludedAttachments, 0);
  assert.deepEqual(stats.matchedKeys, []);
  assert.deepEqual(stats.unmatchedKeys, []);
});

test("applyExcludes drops records and attachments by itemKey or citationKey", () => {
  const data: CatalogData = {
    records: [
      makeRecord("KEEPITEM", "lee2024keep"),
      makeRecord("DROPITEM", "lee2024drop"),
      makeRecord("BYCITKEY", "drop2024cite"),
    ],
    attachments: [
      makeAttachment("KEEPITEM", "lee2024keep", "/tmp/keep.pdf"),
      makeAttachment("DROPITEM", "lee2024drop", "/tmp/drop1.pdf"),
      makeAttachment("DROPITEM", "lee2024drop", "/tmp/drop2.pdf"),
      makeAttachment("BYCITKEY", "drop2024cite", "/tmp/bycitekey.pdf"),
    ],
  };
  const excludes = new Set(["DROPITEM", "drop2024cite"]);
  const { filtered, stats } = applyExcludes(data, excludes);

  assert.deepEqual(filtered.records.map((r) => r.itemKey), ["KEEPITEM"]);
  assert.deepEqual(filtered.attachments.map((a) => a.filePath), ["/tmp/keep.pdf"]);
  assert.equal(stats.excludedRecords, 2);
  assert.equal(stats.excludedAttachments, 3);
  assert.deepEqual(stats.matchedKeys.sort(), ["DROPITEM", "drop2024cite"].sort());
  assert.deepEqual(stats.unmatchedKeys, []);
});

test("applyExcludes reports keys that did not match any bibliography entry", () => {
  const data: CatalogData = {
    records: [makeRecord("PRESENT1")],
    attachments: [makeAttachment("PRESENT1", undefined, "/tmp/p.pdf")],
  };
  const excludes = new Set(["PRESENT1", "STALE_KEY", "another-typo"]);
  const { filtered, stats } = applyExcludes(data, excludes);
  assert.equal(filtered.records.length, 0);
  assert.deepEqual(stats.matchedKeys, ["PRESENT1"]);
  assert.deepEqual(stats.unmatchedKeys.sort(), ["STALE_KEY", "another-typo"].sort());
});
