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
  assert.equal(
    result.results[0]?.abstract,
    "Large language models interpret political texts meaningfully and remain scalable for cross-national analysis.",
  );
  assert.equal(result.results[0]?.journal, "American Journal of Political Science");
  assert.equal(result.results[0]?.hasSupportedFile, true);
  assert.deepEqual(result.results[0]?.supportedFiles, [pdfPath, epubPath]);

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
  assert.deepEqual(thesisPublisher.results, []);

  const thesisTitle = await searchMetadata("Institutional Change in China", 10, {
    bibliographyJsonPath: bibliographyPath,
    attachmentsRoot,
    dataDir,
  });
  assert.equal(thesisTitle.results.length, 1);
  assert.equal("publisher" in thesisTitle.results[0]!, false);
});
