import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { searchMetadata } from "../../src/metadata.js";

function createFixturePaths(root: string): {
  attachmentsRoot: string;
  pdfPath: string;
  epubPath: string;
} {
  const attachmentsRoot = join(root, "attachments");
  mkdirSync(join(attachmentsRoot, "papers"), { recursive: true });
  const pdfPath = join(attachmentsRoot, "papers", "article.pdf");
  const epubPath = join(attachmentsRoot, "papers", "book.epub");
  writeFileSync(pdfPath, "pdf");
  writeFileSync(epubPath, "epub");

  return {
    attachmentsRoot,
    pdfPath,
    epubPath,
  };
}

function writeBibliography(root: string, items: unknown[]): { bibliographyPath: string; dataDir: string } {
  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(bibliographyPath, JSON.stringify(items), "utf-8");
  return { bibliographyPath, dataDir: join(root, "data") };
}

test("searchMetadata works without sync and returns metadata-only records", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-metadata-"));
  const { attachmentsRoot, pdfPath, epubPath } = createFixturePaths(root);
  const { bibliographyPath, dataDir } = writeBibliography(root, [
    {
      id: "benoit2026ull",
      title: "Using large language models to analyze political texts",
      abstract:
        "Large language models interpret political texts meaningfully and remain scalable for cross-national analysis.",
      author: [{ family: "Benoit", given: "Kenneth" }],
      issued: { "date-parts": [[2026]] },
      "container-title": "American Journal of Political Science",
      type: "article-journal",
      file: `${pdfPath};${epubPath}`,
      "zotero-item-key": "ITEM1",
    },
    {
      id: "book2024",
      title: "China and Political Economy",
      abstract: "A book without attachments should still be searchable.",
      author: [{ family: "Smith", given: "Jane" }],
      issued: { "date-parts": [[2024]] },
      publisher: "Cambridge University Press",
      type: "book",
      "zotero-item-key": "ITEM2",
    },
    {
      id: "epub2023",
      title: "EPUB only item",
      abstract: "This record has only an epub attachment.",
      author: [{ family: "Doe", given: "John" }],
      issued: { "date-parts": [[2023]] },
      publisher: "EPUB Press",
      type: "book",
      file: epubPath,
      "zotero-item-key": "ITEM3",
    },
  ]);

  const result = await searchMetadata("large language models", 10, {
    bibliographyJsonPath: bibliographyPath,
    attachmentsRoot,
    dataDir,
  });

  assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0]?.matchedFields, ["title", "abstract"]);
  assert.equal("abstract" in result.results[0]!, false);
  assert.equal(result.results[0]?.journal, "American Journal of Political Science");
  assert.equal(result.results[0]?.hasSupportedFile, true);
  assert.deepEqual(result.results[0]?.supportedFiles, [pdfPath, epubPath]);

  const withAbstract = await searchMetadata(
    "large language models",
    10,
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    { includeAbstract: true },
  );
  assert.equal(
    withAbstract.results[0]?.abstract,
    "Large language models interpret political texts meaningfully and remain scalable for cross-national analysis.",
  );

  const metadataOnly = await searchMetadata("China and Political Economy", 10, {
    bibliographyJsonPath: bibliographyPath,
    attachmentsRoot,
    dataDir,
  });

  assert.equal(metadataOnly.results.length, 1);
  assert.equal(metadataOnly.results[0]?.itemKey, "ITEM2");
  assert.equal(metadataOnly.results[0]?.hasSupportedFile, false);
  assert.deepEqual(metadataOnly.results[0]?.supportedFiles, []);

  const hasFileOnly = await searchMetadata(
    "political",
    10,
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    { hasFile: true },
  );

  assert.deepEqual(
    hasFileOnly.results.map((row) => row.itemKey),
    ["ITEM1"],
  );
});

test("searchMetadata supports author variants and field filtering", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-metadata-author-"));
  const { attachmentsRoot } = createFixturePaths(root);
  const { bibliographyPath, dataDir } = writeBibliography(root, [
    {
      id: "benoit2026ull",
      title: "Using large language models to analyze political texts",
      abstract: "Large language models interpret political texts meaningfully.",
      author: [{ family: "Benoit", given: "Kenneth" }],
      issued: { "date-parts": [[2026]] },
      "container-title": "American Journal of Political Science",
      type: "article-journal",
      "zotero-item-key": "ITEM1",
    },
    {
      id: "chapter2025",
      title: "Coalition Formation in Europe",
      abstract: "A chapter in an edited volume.",
      author: [{ family: "Brown", given: "Alice" }],
      issued: { "date-parts": [[2025]] },
      "container-title": "Handbook of Coalition Politics",
      publisher: "Oxford University Press",
      type: "chapter",
      "zotero-item-key": "ITEM2",
    },
    {
      id: "thesis2024",
      title: "Institutional Change in China",
      abstract: "A thesis record.",
      author: [{ literal: "Xu Mingjun" }],
      issued: { "date-parts": [[2024]] },
      publisher: "East University",
      type: "thesis",
      "zotero-item-key": "ITEM3",
    },
  ]);

  const authorVariant = await searchMetadata("Kenneth Benoit", 10, {
    bibliographyJsonPath: bibliographyPath,
    attachmentsRoot,
    dataDir,
  });
  assert.deepEqual(
    authorVariant.results.map((row) => row.itemKey),
    ["ITEM1"],
  );
  assert.deepEqual(authorVariant.results[0]?.matchedFields, ["author"]);

  const journalOnly = await searchMetadata(
    "American Journal of Political Science",
    10,
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    { fields: ["journal"] },
  );
  assert.deepEqual(
    journalOnly.results.map((row) => row.itemKey),
    ["ITEM1"],
  );

  const chapterJournal = await searchMetadata(
    "Handbook of Coalition Politics",
    10,
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    { fields: ["journal"] },
  );
  assert.deepEqual(chapterJournal.results, []);

  const chapterPublisher = await searchMetadata(
    "Oxford University Press",
    10,
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    { fields: ["publisher"] },
  );
  assert.deepEqual(
    chapterPublisher.results.map((row) => row.itemKey),
    ["ITEM2"],
  );
  assert.equal(chapterPublisher.results[0]?.publisher, "Oxford University Press");

  const thesisPublisher = await searchMetadata(
    "East University",
    10,
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    { fields: ["publisher"] },
  );
  assert.deepEqual(
    thesisPublisher.results.map((row) => row.itemKey),
    ["ITEM3"],
  );
  assert.equal(thesisPublisher.results[0]?.publisher, "East University");

  const thesisTitle = await searchMetadata("Institutional Change in China", 10, {
    bibliographyJsonPath: bibliographyPath,
    attachmentsRoot,
    dataDir,
  });
  assert.equal(thesisTitle.results.length, 1);
  assert.equal(thesisTitle.results[0]?.publisher, "East University");
});

test("searchMetadata field-filter flags AND across fields and allow empty query", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-metadata-filter-"));
  const { attachmentsRoot } = createFixturePaths(root);
  const { bibliographyPath, dataDir } = writeBibliography(root, [
    {
      id: "pratt1985",
      title: "Scratches on the Face of the Country",
      author: [{ family: "Pratt", given: "Mary Louise" }],
      issued: { "date-parts": [[1985]] },
      "container-title": "Critical Inquiry",
      type: "article-journal",
      "zotero-item-key": "ITEM1",
    },
    {
      id: "pratt1992",
      title: "Imperial Eyes",
      author: [{ family: "Pratt", given: "Mary Louise" }],
      issued: { "date-parts": [[1992]] },
      publisher: "Routledge",
      type: "book",
      "zotero-item-key": "ITEM2",
    },
    {
      id: "other1985",
      title: "Another 1985 Study",
      author: [{ family: "Smith", given: "Jane" }],
      issued: { "date-parts": [[1985]] },
      type: "article-journal",
      "zotero-item-key": "ITEM3",
    },
  ]);

  const overrides = { bibliographyJsonPath: bibliographyPath, attachmentsRoot, dataDir };

  // Author + year narrows to the one paper a query string could never reach.
  const authorAndYear = await searchMetadata("", 10, overrides, {
    filters: { author: "Pratt", year: "1985" },
  });
  assert.deepEqual(
    authorAndYear.results.map((row) => row.itemKey),
    ["ITEM1"],
  );
  assert.deepEqual(authorAndYear.results[0]?.matchedFields, ["author", "year"]);

  // Filter-only by year substring spans a range.
  const yearPrefix = await searchMetadata("", 10, overrides, {
    filters: { year: "198" },
  });
  assert.deepEqual(
    yearPrefix.results.map((row) => row.itemKey).sort(),
    ["ITEM1", "ITEM3"],
  );

  // Positional query still required to hit; filter ANDs on top.
  const queryPlusFilter = await searchMetadata("imperial", 10, overrides, {
    filters: { author: "Pratt" },
  });
  assert.deepEqual(
    queryPlusFilter.results.map((row) => row.itemKey),
    ["ITEM2"],
  );
  assert.ok(queryPlusFilter.results[0]?.matchedFields.includes("title"));
  assert.ok(queryPlusFilter.results[0]?.matchedFields.includes("author"));

  // Empty query and empty filters rejected.
  await assert.rejects(
    () => searchMetadata("", 10, overrides, {}),
    /requires a query or at least one field filter/,
  );
});

test("searchMetadata filters locally by Zotero item keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-metadata-item-key-filter-"));
  const { attachmentsRoot } = createFixturePaths(root);
  const { bibliographyPath, dataDir } = writeBibliography(root, [
    {
      id: "thesis2026",
      title: "Local State Capacity in Late Qing China",
      author: [{ family: "Wang", given: "Lin" }],
      issued: { "date-parts": [[2026]] },
      type: "thesis",
      "zotero-item-key": "THESIS01",
    },
    {
      id: "article2025",
      title: "Local State Capacity in Comparative Perspective",
      author: [{ family: "Smith", given: "Jane" }],
      issued: { "date-parts": [[2025]] },
      type: "article-journal",
      "zotero-item-key": "ARTICLE1",
    },
  ]);

  const overrides = { bibliographyJsonPath: bibliographyPath, attachmentsRoot, dataDir };

  const taggedQuery = await searchMetadata("local state capacity", 10, overrides, {
    itemKeys: ["THESIS01"],
  });
  assert.deepEqual(
    taggedQuery.results.map((row) => row.itemKey),
    ["THESIS01"],
  );

  const tagOnly = await searchMetadata("", 10, overrides, {
    itemKeys: ["ARTICLE1"],
  });
  assert.deepEqual(
    tagOnly.results.map((row) => row.itemKey),
    ["ARTICLE1"],
  );
  assert.deepEqual(tagOnly.results[0]?.matchedFields, []);

  const noTaggedItems = await searchMetadata("", 10, overrides, {
    itemKeys: [],
  });
  assert.deepEqual(noTaggedItems.results, []);

  const partial = await searchMetadata("", 10, overrides, {
    itemKeys: ["THESIS01", "MISSING1"],
  });
  assert.deepEqual(
    partial.results.map((row) => row.itemKey),
    ["THESIS01"],
  );
  assert.ok(
    partial.warnings?.some((w) => /1 of 2 matched items is missing from the bibliography/u.test(w)),
  );
});

test("searchMetadata exposes publisher for thesis, report, and paper-conference items", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-metadata-publisher-types-"));
  const { attachmentsRoot } = createFixturePaths(root);
  const { bibliographyPath, dataDir } = writeBibliography(root, [
    {
      id: "thesisFixture",
      title: "Land Reform in Western China",
      author: [{ literal: "Lu Shenghua" }],
      issued: { "date-parts": [[2022]] },
      publisher: "Zhejiang University",
      type: "thesis",
      "zotero-item-key": "THESIS1",
    },
    {
      id: "reportFixture",
      title: "Working Paper on Urban Development",
      author: [{ family: "Chen", given: "Wei" }],
      issued: { "date-parts": [[2021]] },
      publisher: "National Bureau of Economic Research",
      type: "report",
      "zotero-item-key": "REPORT1",
    },
    {
      id: "confFixture",
      title: "Distributed Systems at Scale",
      author: [{ family: "Liu", given: "Yang" }],
      issued: { "date-parts": [[2020]] },
      publisher: "Association for Computing Machinery",
      type: "paper-conference",
      "zotero-item-key": "CONF1",
    },
  ]);

  const overrides = { bibliographyJsonPath: bibliographyPath, attachmentsRoot, dataDir };

  const thesisHit = await searchMetadata("Zhejiang University", 10, overrides, {
    fields: ["publisher"],
  });
  assert.deepEqual(
    thesisHit.results.map((row) => row.itemKey),
    ["THESIS1"],
  );
  assert.equal(thesisHit.results[0]?.publisher, "Zhejiang University");

  const reportHit = await searchMetadata("", 10, overrides, {
    filters: { publisher: "National Bureau" },
  });
  assert.deepEqual(
    reportHit.results.map((row) => row.itemKey),
    ["REPORT1"],
  );
  assert.equal(reportHit.results[0]?.publisher, "National Bureau of Economic Research");

  const confHit = await searchMetadata("", 10, overrides, {
    filters: { publisher: "Association for Computing Machinery" },
  });
  assert.deepEqual(
    confHit.results.map((row) => row.itemKey),
    ["CONF1"],
  );
  assert.equal(confHit.results[0]?.publisher, "Association for Computing Machinery");
});
