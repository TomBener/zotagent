import test from "node:test";
import assert from "node:assert/strict";

import type { CatalogData } from "../../src/catalog.js";
import { applyExcludes } from "../../src/excludes.js";
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

test("applyExcludes drops records and attachments whose itemKey is tagged", () => {
  const data: CatalogData = {
    records: [
      makeRecord("KEEPITEM", "lee2024keep"),
      makeRecord("DROPITEM", "lee2024drop"),
    ],
    attachments: [
      makeAttachment("KEEPITEM", "lee2024keep", "/tmp/keep.pdf"),
      makeAttachment("DROPITEM", "lee2024drop", "/tmp/drop1.pdf"),
      makeAttachment("DROPITEM", "lee2024drop", "/tmp/drop2.pdf"),
    ],
  };
  const excludes = new Set(["DROPITEM"]);
  const { filtered, stats } = applyExcludes(data, excludes);

  assert.deepEqual(filtered.records.map((r) => r.itemKey), ["KEEPITEM"]);
  assert.deepEqual(filtered.attachments.map((a) => a.filePath), ["/tmp/keep.pdf"]);
  assert.equal(stats.excludedRecords, 1);
  assert.equal(stats.excludedAttachments, 2);
  assert.deepEqual(stats.matchedKeys, ["DROPITEM"]);
  assert.deepEqual(stats.unmatchedKeys, []);
});

test("applyExcludes ignores citationKey membership in the tag-fetched set", () => {
  // The tag-driven flow always yields itemKeys from the Zotero API, so the
  // filter only matches on itemKey. A citationKey accidentally placed in the
  // set is treated as a stale entry and reported as unmatched.
  const data: CatalogData = {
    records: [makeRecord("KEEPITEM", "lee2024keep")],
    attachments: [makeAttachment("KEEPITEM", "lee2024keep", "/tmp/keep.pdf")],
  };
  const excludes = new Set(["lee2024keep"]);
  const { filtered, stats } = applyExcludes(data, excludes);
  assert.equal(filtered.records.length, 1);
  assert.equal(stats.excludedRecords, 0);
  assert.deepEqual(stats.unmatchedKeys, ["lee2024keep"]);
});

test("applyExcludes reports keys whose itemKey didn't match any bibliography entry", () => {
  // Common case: a Zotero item is tagged but its attachment hasn't been
  // re-exported through Better BibTeX yet, so it's not in the bibliography.
  const data: CatalogData = {
    records: [makeRecord("PRESENT1")],
    attachments: [makeAttachment("PRESENT1", undefined, "/tmp/p.pdf")],
  };
  const excludes = new Set(["PRESENT1", "STALEKEY"]);
  const { filtered, stats } = applyExcludes(data, excludes);
  assert.equal(filtered.records.length, 0);
  assert.deepEqual(stats.matchedKeys, ["PRESENT1"]);
  assert.deepEqual(stats.unmatchedKeys, ["STALEKEY"]);
});
