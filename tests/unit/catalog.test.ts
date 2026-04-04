import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCatalog } from "../../src/catalog.js";
import { sha1 } from "../../src/utils.js";

test("loadCatalog keeps attachments inside root and marks only pdf as supported", () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-catalog-"));
  const attachmentsRoot = join(root, "attachments");
  mkdirSync(join(attachmentsRoot, "papers"), { recursive: true });
  const pdfPath = join(attachmentsRoot, "papers", "paper.pdf");
  const epubPath = join(attachmentsRoot, "papers", "book.epub");
  writeFileSync(pdfPath, "pdf");
  writeFileSync(epubPath, "epub");

  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "citekey",
        title: "Paper",
        author: [{ family: "Smith", given: "Jane" }],
        issued: { "date-parts": [[2024]] },
        "container-title": "Journal of Testing",
        file: `${pdfPath};${epubPath};/tmp/outside.pdf`,
        type: "article-journal",
        "zotero-item-key": "ITEM1",
      },
    ]),
    "utf-8",
  );

  const catalog = loadCatalog({
    bibliographyJsonPath: bibliographyPath,
    attachmentsRoot,
    dataDir: join(root, "data"),
    warnings: [],
  });

  assert.equal(catalog.records.length, 1);
  assert.deepEqual(catalog.records[0]?.authorSearchTexts, ["Smith Jane", "Jane Smith"]);
  assert.equal(catalog.records[0]?.journal, "Journal of Testing");
  assert.deepEqual(catalog.records[0]?.supportedPdfFiles, [pdfPath]);
  assert.equal(catalog.records[0]?.hasSupportedPdf, true);
  assert.equal(catalog.attachments.length, 2);
  assert.equal(catalog.attachments[0]!.supported, false);
  assert.equal(catalog.attachments[0]!.fileExt, "epub");
  assert.equal(catalog.attachments[1]!.supported, true);
  assert.equal(catalog.attachments[1]!.fileExt, "pdf");
});

test("loadCatalog remaps bibliography attachment paths into the current attachmentsRoot", () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-catalog-relocate-"));
  const attachmentsRoot = join(root, "miniagent", "Zotero");
  const bibliographyRoot = join(root, "rentao", "Zotero");
  mkdirSync(join(attachmentsRoot, "papers"), { recursive: true });

  const pdfPath = join(attachmentsRoot, "papers", "paper.pdf");
  const epubPath = join(attachmentsRoot, "papers", "book.epub");
  writeFileSync(pdfPath, "pdf");
  writeFileSync(epubPath, "epub");

  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "citekey",
        title: "Portable Paper",
        author: [{ family: "Smith", given: "Jane" }],
        issued: { "date-parts": [[2024]] },
        file: `${join(bibliographyRoot, "papers", "paper.pdf")};${join(
          bibliographyRoot,
          "papers",
          "book.epub",
        )}`,
        type: "article-journal",
        "zotero-item-key": "ITEM1",
      },
    ]),
    "utf-8",
  );

  const catalog = loadCatalog({
    bibliographyJsonPath: bibliographyPath,
    attachmentsRoot,
    dataDir: join(root, "data"),
    warnings: [],
  });

  assert.deepEqual(catalog.records[0]?.attachmentPaths, [pdfPath, epubPath]);
  assert.deepEqual(catalog.records[0]?.supportedPdfFiles, [pdfPath]);
  assert.deepEqual(
    catalog.attachments.map((entry) => entry.docKey),
    [sha1("papers/book.epub"), sha1("papers/paper.pdf")],
  );
  assert.deepEqual(
    catalog.attachments.map((entry) => entry.filePath),
    [epubPath, pdfPath],
  );
});

test("loadCatalog only relocates files that match the requested Zotero subfolder tail", () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-catalog-subfolder-"));
  const attachmentsRoot = join(root, "miniagent", "Zotero", "CSS & Social Media", "preprint");
  const bibliographyRoot = join(root, "rentao", "Zotero");
  mkdirSync(attachmentsRoot, { recursive: true });

  const keptPdfPath = join(attachmentsRoot, "kept.pdf");
  writeFileSync(keptPdfPath, "pdf");

  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "citekey",
        title: "Portable Paper",
        author: [{ family: "Smith", given: "Jane" }],
        file: [
          join(bibliographyRoot, "CSS & Social Media", "preprint", "kept.pdf"),
          join(bibliographyRoot, "other-folder", "should-not-appear.pdf"),
        ].join(";"),
        type: "article-journal",
        "zotero-item-key": "ITEM1",
      },
    ]),
    "utf-8",
  );

  const catalog = loadCatalog({
    bibliographyJsonPath: bibliographyPath,
    attachmentsRoot,
    dataDir: join(root, "data"),
    warnings: [],
  });

  assert.deepEqual(catalog.records[0]?.attachmentPaths, [keptPdfPath]);
  assert.deepEqual(catalog.records[0]?.supportedPdfFiles, [keptPdfPath]);
  assert.equal(catalog.attachments.length, 1);
  assert.equal(catalog.attachments[0]?.filePath, keptPdfPath);
});
