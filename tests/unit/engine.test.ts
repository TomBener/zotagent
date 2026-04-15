import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expandDocument, fullTextDocument, fullTextDocuments, readDocument, searchLiterature, searchWithinDocuments } from "../../src/engine.js";
import { writeCatalogFile } from "../../src/state.js";
import type { AttachmentManifest, CatalogFile } from "../../src/types.js";
import { MANIFEST_EXT, writeManifestFile } from "../../src/utils.js";

function writeManifest(path: string, manifest: AttachmentManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeManifestFile(path, manifest);
}

test("searchLiterature prefers substantive hits over reference-only hits", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-engine-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const substantiveDocKey = "1".repeat(40);
  const referenceDocKey = "2".repeat(40);
  const substantiveManifestPath = join(manifestsDir, `${substantiveDocKey}${MANIFEST_EXT}`);
  const referenceManifestPath = join(manifestsDir, `${referenceDocKey}${MANIFEST_EXT}`);

  writeManifest(substantiveManifestPath, {
    docKey: substantiveDocKey,
    itemKey: "ITEM1",
    title: "Substantive",
    authors: ["A"],
    filePath: "/tmp/substantive.pdf",
    normalizedPath: join(dataDir, "normalized", `${substantiveDocKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Discussion"],
        text: "Population ageing in China is reshaping care arrangements.",
        charStart: 0,
        charEnd: 58,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
    ],
  });
  writeManifest(referenceManifestPath, {
    docKey: referenceDocKey,
    itemKey: "ITEM2",
    title: "Reference",
    authors: ["B"],
    filePath: "/tmp/reference.pdf",
    normalizedPath: join(dataDir, "normalized", `${referenceDocKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["References"],
        text: "Smith, J. (2022). Ageing in China.",
        charStart: 0,
        charEnd: 34,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: true,
      },
    ],
  });

  const catalog: CatalogFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [
      {
        docKey: substantiveDocKey,
        itemKey: "ITEM1",
        title: "Substantive",
        authors: ["A"],
        filePath: "/tmp/substantive.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash1",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${substantiveDocKey}.md`),
        manifestPath: substantiveManifestPath,
      },
      {
        docKey: referenceDocKey,
        itemKey: "ITEM2",
        title: "Reference",
        authors: ["B"],
        filePath: "/tmp/reference.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash2",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${referenceDocKey}.md`),
        manifestPath: referenceManifestPath,
      },
    ],
  };
  writeCatalogFile(join(indexDir, "catalog.json"), catalog);

  let capturedSearchOptions: { query?: string; limit?: number; rerank?: boolean; minScore?: number } | undefined;

  const fakeFactory = async () => ({
    search: async (options: { query?: string; limit?: number; rerank?: boolean; minScore?: number }) => {
      capturedSearchOptions = options;
      return [
        {
          file: `qmd://library/${referenceDocKey}.md`,
          displayPath: `${referenceDocKey}.md`,
          title: "Reference",
          body: "Smith, J. (2022). Ageing in China.",
          bestChunk: "Smith, J. (2022). Ageing in China.",
          bestChunkPos: 0,
          score: 0.98,
          context: null,
          docid: "222222",
        },
        {
          file: `qmd://library/${substantiveDocKey}.md`,
          displayPath: `${substantiveDocKey}.md`,
          title: "Substantive",
          body: "Population ageing in China is reshaping care arrangements.",
          bestChunk: "Population ageing in China is reshaping care arrangements.",
          bestChunkPos: 0,
          score: 0.81,
          context: null,
          docid: "111111",
        },
      ];
    },
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ documents: 2, collections: [], embeddings: { total: 2, stale: 0 } }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    close: async () => {},
  });

  const result = await searchLiterature(
    "aging in China",
    1,
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
    fakeFactory,
  );

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]!.itemKey, "ITEM1");
  assert.equal("warnings" in result, false);
  assert.equal(capturedSearchOptions?.rerank, false);
});

test("searchLiterature forwards explicit rerank override", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const preciseDocKey = "7".repeat(40);
  const broadDocKey = "8".repeat(40);
  const preciseManifestPath = join(manifestsDir, `${preciseDocKey}${MANIFEST_EXT}`);
  const broadManifestPath = join(manifestsDir, `${broadDocKey}${MANIFEST_EXT}`);

  writeManifest(preciseManifestPath, {
    docKey: preciseDocKey,
    itemKey: "ITEM1",
    title: "Precise match",
    authors: ["A"],
    filePath: "/tmp/precise.pdf",
    normalizedPath: join(dataDir, "normalized", `${preciseDocKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "The top leader is the company party secretary, dangwei shuji.",
        charStart: 0,
        charEnd: 63,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
    ],
  });
  writeManifest(broadManifestPath, {
    docKey: broadDocKey,
    itemKey: "ITEM2",
    title: "Broad match",
    authors: ["B"],
    filePath: "/tmp/broad.pdf",
    normalizedPath: join(dataDir, "normalized", `${broadDocKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Intro"],
        text: "This article discusses state-owned enterprises and governance.",
        charStart: 0,
        charEnd: 60,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [
      {
        docKey: preciseDocKey,
        itemKey: "ITEM1",
        title: "Precise match",
        authors: ["A"],
        filePath: "/tmp/precise.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash7",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${preciseDocKey}.md`),
        manifestPath: preciseManifestPath,
      },
      {
        docKey: broadDocKey,
        itemKey: "ITEM2",
        title: "Broad match",
        authors: ["B"],
        filePath: "/tmp/broad.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash8",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${broadDocKey}.md`),
        manifestPath: broadManifestPath,
      },
    ],
  });

  let capturedSearchOptions: { query: string; limit?: number; rerank?: boolean; minScore?: number } | undefined;

  const fakeFactory = async () => ({
    search: async (options: { query: string; limit?: number; rerank?: boolean; minScore?: number }) => {
      capturedSearchOptions = options;
      return [
      {
        file: `qmd://library/${preciseDocKey}.md`,
        displayPath: `${preciseDocKey}.md`,
        title: "Precise match",
        body: "The top leader is the company party secretary, dangwei shuji.",
        bestChunk: "The top leader is the company party secretary, dangwei shuji.",
        bestChunkPos: 0,
        score: 0.93,
        context: null,
        docid: "777777",
      },
      {
        file: `qmd://library/${broadDocKey}.md`,
        displayPath: `${broadDocKey}.md`,
        title: "Broad match",
        body: "This article discusses state-owned enterprises and governance.",
        bestChunk: "This article discusses state-owned enterprises and governance.",
        bestChunkPos: 0,
        score: 0.5,
        context: null,
        docid: "888888",
      },
      ];
    },
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ documents: 2, collections: [], embeddings: { total: 2, stale: 0 } }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    close: async () => {},
  });

  const result = await searchLiterature(
    "dangwei shuji",
    10,
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
    fakeFactory,
    { rerank: true },
  );

  assert.equal(capturedSearchOptions?.rerank, true);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0]!.itemKey, "ITEM1");
});

test("searchLiterature exact mode uses the exact index and skips qmd", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-exact-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const exactDocKey = "9".repeat(40);
  const exactManifestPath = join(manifestsDir, `${exactDocKey}${MANIFEST_EXT}`);

  writeManifest(exactManifestPath, {
    docKey: exactDocKey,
    itemKey: "ITEM9",
    title: "Exact match",
    authors: ["A"],
    filePath: "/tmp/exact.pdf",
    normalizedPath: join(dataDir, "normalized", `${exactDocKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "The top leader is the company party secretary, dangwei shuji.",
        charStart: 0,
        charEnd: 63,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [
      {
        docKey: exactDocKey,
        itemKey: "ITEM9",
        title: "Exact match",
        authors: ["A"],
        filePath: "/tmp/exact.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash9",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${exactDocKey}.md`),
        manifestPath: exactManifestPath,
      },
    ],
  });

  let qmdSearchCalled = false;
  let capturedExactQuery: string | undefined;
  let capturedExactLimit: number | undefined;

  const fakeFactory = async () => ({
    search: async (options: {
      query?: string;
      queries?: Array<{ type: "lex" | "vec" | "hyde"; query: string }>;
      limit?: number;
      rerank?: boolean;
      minScore?: number;
    }) => {
      qmdSearchCalled = true;
      return [];
    },
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ documents: 1, collections: [], embeddings: { total: 1, stale: 0 } }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    close: async () => {},
  });
  const fakeExactFactory = async () => ({
    rebuildExactIndex: async () => {},
    searchExactCandidates: async (inputQuery: string, inputLimit: number) => {
      capturedExactQuery = inputQuery;
      capturedExactLimit = inputLimit;
      return [
        {
          docKey: exactDocKey,
          score: 1,
        },
      ];
    },
    close: async () => {},
  });

  const result = await searchLiterature(
    "dangwei shuji",
    10,
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
    fakeFactory,
    { exact: true },
    fakeExactFactory,
  );

  assert.equal(qmdSearchCalled, false);
  assert.equal(capturedExactQuery, "dangwei shuji");
  assert.equal(capturedExactLimit, 10);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]!.itemKey, "ITEM9");
  assert.match(result.results[0]!.passage, /dangwei shuji/i);
});

test("searchWithinDocuments returns passages from the selected attachment", () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-search-in-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "f".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMS",
    citationKey: "lee2024searchin",
    title: "Search In",
    authors: ["A"],
    filePath: "/tmp/search-in.pdf",
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "heading",
        sectionPath: ["Governance"],
        text: "Governance",
        charStart: 0,
        charEnd: 10,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
      {
        blockIndex: 1,
        blockType: "paragraph",
        sectionPath: ["Governance"],
        text: "The top leader is the company party secretary, dangwei shuji.",
        charStart: 12,
        charEnd: 75,
        lineStart: 3,
        lineEnd: 3,
        isReferenceLike: false,
      },
      {
        blockIndex: 2,
        blockType: "paragraph",
        sectionPath: ["Governance"],
        text: "Party organization shapes firm governance.",
        charStart: 77,
        charEnd: 118,
        lineStart: 5,
        lineEnd: 5,
        isReferenceLike: false,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [
      {
        docKey,
        itemKey: "ITEMS",
        citationKey: "lee2024searchin",
        title: "Search In",
        authors: ["A"],
        filePath: "/tmp/search-in.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-search-in",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
        manifestPath,
      },
    ],
  });

  const result = searchWithinDocuments(
    "dangwei shuji",
    { itemKey: "ITEMS" },
    10,
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
  );

  assert.equal(result.results.length > 0, true);
  assert.equal(result.results[0]!.itemKey, "ITEMS");
  assert.match(result.results[0]!.passage, /dangwei shuji/i);
  assert.equal(result.results[0]!.blockStart, 1);
  assert.equal(result.results[0]!.blockEnd, 1);
});

test("searchWithinDocuments searches across multiple attachments for the same key", () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-search-in-multi-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docOne = "g".repeat(40);
  const docTwo = "h".repeat(40);
  const manifestOnePath = join(manifestsDir, `${docOne}${MANIFEST_EXT}`);
  const manifestTwoPath = join(manifestsDir, `${docTwo}${MANIFEST_EXT}`);

  writeManifest(manifestOnePath, {
    docKey: docOne,
    itemKey: "ITEMS",
    citationKey: "lee2024multi-search",
    title: "Doc One",
    authors: ["A"],
    filePath: "/tmp/search-one.pdf",
    normalizedPath: join(dataDir, "normalized", `${docOne}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "Unique paragraph one.",
        charStart: 0,
        charEnd: 21,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
    ],
  });
  writeManifest(manifestTwoPath, {
    docKey: docTwo,
    itemKey: "ITEMS",
    citationKey: "lee2024multi-search",
    title: "Doc Two",
    authors: ["B"],
    filePath: "/tmp/search-two.pdf",
    normalizedPath: join(dataDir, "normalized", `${docTwo}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "Unique paragraph two.",
        charStart: 0,
        charEnd: 21,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [
      {
        docKey: docOne,
        itemKey: "ITEMS",
        citationKey: "lee2024multi-search",
        title: "Doc One",
        authors: ["A"],
        filePath: "/tmp/search-one.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-search-one",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${docOne}.md`),
        manifestPath: manifestOnePath,
      },
      {
        docKey: docTwo,
        itemKey: "ITEMS",
        citationKey: "lee2024multi-search",
        title: "Doc Two",
        authors: ["B"],
        filePath: "/tmp/search-two.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-search-two",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${docTwo}.md`),
        manifestPath: manifestTwoPath,
      },
    ],
  });

  const result = searchWithinDocuments(
    "unique paragraph",
    { itemKey: "ITEMS" },
    10,
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
  );

  assert.equal(result.results.length, 2);
  assert.deepEqual(
    result.results.map((row) => row.file),
    ["/tmp/search-one.pdf", "/tmp/search-two.pdf"],
  );
});

test("readDocument reports multi-attachment conflict and expandDocument returns context blocks", () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-read-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docOne = "3".repeat(40);
  const docTwo = "4".repeat(40);
  const manifestOnePath = join(manifestsDir, `${docOne}${MANIFEST_EXT}`);
  const manifestTwoPath = join(manifestsDir, `${docTwo}${MANIFEST_EXT}`);

  writeManifest(manifestOnePath, {
    docKey: docOne,
    itemKey: "ITEM1",
    citationKey: "smith2024one",
    title: "Doc One",
    authors: ["A"],
    filePath: "/tmp/doc-one.pdf",
    normalizedPath: join(dataDir, "normalized", `${docOne}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "heading",
        sectionPath: ["Intro"],
        text: "Intro",
        charStart: 0,
        charEnd: 7,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
      {
        blockIndex: 1,
        blockType: "paragraph",
        sectionPath: ["Intro"],
        text: "Paragraph one.",
        charStart: 9,
        charEnd: 23,
        lineStart: 3,
        lineEnd: 3,
        isReferenceLike: false,
      },
      {
        blockIndex: 2,
        blockType: "paragraph",
        sectionPath: ["Intro"],
        text: "Paragraph two.",
        charStart: 25,
        charEnd: 39,
        lineStart: 5,
        lineEnd: 5,
        isReferenceLike: false,
      },
    ],
  });
  writeManifest(manifestTwoPath, {
    docKey: docTwo,
    itemKey: "ITEM1",
    citationKey: "smith2024two",
    title: "Doc Two",
    authors: ["A"],
    filePath: "/tmp/doc-two.pdf",
    normalizedPath: join(dataDir, "normalized", `${docTwo}.md`),
    blocks: [],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [
      {
        docKey: docOne,
        itemKey: "ITEM1",
        citationKey: "smith2024one",
        title: "Doc One",
        authors: ["A"],
        filePath: "/tmp/doc-one.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash3",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${docOne}.md`),
        manifestPath: manifestOnePath,
      },
      {
        docKey: docTwo,
        itemKey: "ITEM1",
        citationKey: "smith2024two",
        title: "Doc Two",
        authors: ["A"],
        filePath: "/tmp/doc-two.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash4",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${docTwo}.md`),
        manifestPath: manifestTwoPath,
      },
    ],
  });

  assert.throws(
    () =>
      readDocument(
        {
          itemKey: "ITEM1",
          offsetBlock: 0,
          limitBlocks: 20,
        },
        {
          bibliographyJsonPath: join(root, "bibliography.json"),
          attachmentsRoot: root,
          dataDir,
        },
      ),
    /Multiple indexed attachments found/,
  );

  const expanded = expandDocument(
    {
      file: "/tmp/doc-one.pdf",
      blockStart: 1,
      blockEnd: 1,
      radius: 1,
    },
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
  );

  assert.equal(expanded.contextStart, 0);
  assert.equal(expanded.contextEnd, 2);
  assert.equal(expanded.blocks.length, 3);
  assert.equal(expanded.passage, "Paragraph one.");
});

test("expandDocument resolves a unique attachment by itemKey", () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-expand-item-key-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "5".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEM5",
    citationKey: "lee2024aging",
    title: "Doc Five",
    authors: ["A"],
    filePath: "/tmp/doc-five.pdf",
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "First block.",
        charStart: 0,
        charEnd: 12,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
      {
        blockIndex: 1,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "Second block.",
        charStart: 14,
        charEnd: 27,
        lineStart: 3,
        lineEnd: 3,
        isReferenceLike: false,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [
      {
        docKey,
        itemKey: "ITEM5",
        citationKey: "lee2024aging",
        title: "Doc Five",
        authors: ["A"],
        filePath: "/tmp/doc-five.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash5",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
        manifestPath,
      },
    ],
  });

  const expanded = expandDocument(
    {
      itemKey: "ITEM5",
      blockStart: 1,
      blockEnd: 1,
      radius: 1,
    },
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
  );

  assert.equal(expanded.itemKey, "ITEM5");
  assert.equal(expanded.file, "/tmp/doc-five.pdf");
  assert.equal(expanded.contextStart, 0);
  assert.equal(expanded.contextEnd, 1);
  assert.equal(expanded.passage, "Second block.");
});

test("readDocument resolves a unique attachment by citationKey", () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-read-citation-key-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "6".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEM6",
    citationKey: "wang2024soe",
    title: "Doc Six",
    authors: ["B"],
    filePath: "/tmp/doc-six.pdf",
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "First block.",
        charStart: 0,
        charEnd: 12,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
      {
        blockIndex: 1,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "Second block.",
        charStart: 14,
        charEnd: 27,
        lineStart: 3,
        lineEnd: 3,
        isReferenceLike: false,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [
      {
        docKey,
        itemKey: "ITEM6",
        citationKey: "wang2024soe",
        title: "Doc Six",
        authors: ["B"],
        filePath: "/tmp/doc-six.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash6",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
        manifestPath,
      },
    ],
  });

  const read = readDocument(
    {
      citationKey: "wang2024soe",
      offsetBlock: 1,
      limitBlocks: 1,
    },
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
  );

  assert.equal(read.itemKey, "ITEM6");
  assert.equal(read.citationKey, "wang2024soe");
  assert.equal(read.file, "/tmp/doc-six.pdf");
  assert.equal(read.blocks.length, 1);
  assert.equal(read.blocks[0]!.text, "Second block.");
});

test("fullTextDocument keeps boilerplate and references by default", () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-fulltext-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  const normalizedDir = join(dataDir, "normalized");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });
  mkdirSync(normalizedDir, { recursive: true });

  const docKey = "a".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  const normalizedPath = join(normalizedDir, `${docKey}.md`);

  writeFileSync(
    normalizedPath,
    [
      "# Introduction",
      "",
      "The top leader is the company party secretary, dangwei shuji.",
      "",
      "Party organization shapes firm governance.",
      "",
      "To cite this article, please use the publisher PDF.",
      "",
      "Party organization shapes firm governance.",
      "",
      "Smith, J. (2022). Ageing in China. Journal of Ageing.",
    ].join("\n"),
    "utf-8",
  );

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMA",
    citationKey: "lee2024agent",
    title: "Agent Readable Doc",
    authors: ["C"],
    filePath: "/tmp/agent.pdf",
    normalizedPath,
    blocks: [
      {
        blockIndex: 0,
        blockType: "heading",
        sectionPath: ["Introduction"],
        text: "Introduction",
        charStart: 0,
        charEnd: 12,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
      {
        blockIndex: 1,
        blockType: "paragraph",
        sectionPath: ["Introduction"],
        text: "The top leader is the company party secretary, dangwei shuji.",
        charStart: 14,
        charEnd: 77,
        lineStart: 3,
        lineEnd: 3,
        isReferenceLike: false,
      },
      {
        blockIndex: 2,
        blockType: "paragraph",
        sectionPath: ["Introduction"],
        text: "Party organization shapes firm governance.",
        charStart: 79,
        charEnd: 120,
        lineStart: 5,
        lineEnd: 5,
        isReferenceLike: false,
      },
      {
        blockIndex: 3,
        blockType: "paragraph",
        sectionPath: ["Front Matter"],
        text: "To cite this article, please use the publisher PDF.",
        charStart: 122,
        charEnd: 175,
        lineStart: 7,
        lineEnd: 7,
        isReferenceLike: false,
      },
      {
        blockIndex: 4,
        blockType: "paragraph",
        sectionPath: ["Introduction"],
        text: "Party organization shapes firm governance.",
        charStart: 177,
        charEnd: 218,
        lineStart: 9,
        lineEnd: 9,
        isReferenceLike: false,
      },
      {
        blockIndex: 5,
        blockType: "paragraph",
        sectionPath: ["References"],
        text: "Smith, J. (2022). Ageing in China. Journal of Ageing.",
        charStart: 220,
        charEnd: 274,
        lineStart: 11,
        lineEnd: 11,
        isReferenceLike: true,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [
      {
        docKey,
        itemKey: "ITEMA",
        citationKey: "lee2024agent",
        title: "Agent Readable Doc",
        authors: ["C"],
        filePath: "/tmp/agent.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-agent",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath,
        manifestPath,
      },
    ],
  });

  const fullText = fullTextDocument(
    {
      citationKey: "lee2024agent",
    },
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
  );

  assert.equal(fullText.itemKey, "ITEMA");
  assert.equal(fullText.citationKey, "lee2024agent");
  assert.equal(fullText.format, "markdown");
  assert.equal(fullText.source, "normalized");
  assert.equal(fullText.keptBlocks, 6);
  assert.equal(fullText.skippedBoilerplateBlocks, 0);
  assert.equal(fullText.skippedDuplicateBlocks, 0);
  assert.match(fullText.content, /^# Introduction/m);
  assert.match(fullText.content, /dangwei shuji/);
  assert.equal(fullText.content.match(/Party organization shapes firm governance\./g)?.length, 2);
  assert.match(fullText.content, /To cite this article/i);
  assert.match(fullText.content, /Smith, J\./);
});

test("fullTextDocument strips boilerplate when clean is enabled", () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-fulltext-clean-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "d".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMC",
    citationKey: "lee2024clean",
    title: "Clean Doc",
    authors: ["C"],
    filePath: "/tmp/clean.pdf",
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Front Matter"],
        text: "To cite this article, please use the publisher PDF.",
        charStart: 0,
        charEnd: 53,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
      {
        blockIndex: 1,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "Main body paragraph.",
        charStart: 55,
        charEnd: 75,
        lineStart: 3,
        lineEnd: 3,
        isReferenceLike: false,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [
      {
        docKey,
        itemKey: "ITEMC",
        citationKey: "lee2024clean",
        title: "Clean Doc",
        authors: ["C"],
        filePath: "/tmp/clean.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-clean",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
        manifestPath,
      },
    ],
  });

  const fullText = fullTextDocument(
    {
      citationKey: "lee2024clean",
      clean: true,
    },
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
  );

  assert.equal(fullText.keptBlocks, 1);
  assert.equal(fullText.skippedBoilerplateBlocks, 1);
  assert.match(fullText.content, /Main body paragraph\./);
  assert.doesNotMatch(fullText.content, /To cite this article/i);
});

test("fullTextDocuments returns all matches for duplicate itemKey and citationKey", () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-fulltext-multi-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docOne = "b".repeat(40);
  const docTwo = "c".repeat(40);
  const manifestOnePath = join(manifestsDir, `${docOne}${MANIFEST_EXT}`);
  const manifestTwoPath = join(manifestsDir, `${docTwo}${MANIFEST_EXT}`);

  writeManifest(manifestOnePath, {
    docKey: docOne,
    itemKey: "ITEMM",
    citationKey: "lee2024multi",
    title: "Doc One",
    authors: ["A"],
    filePath: "/tmp/multi-one.pdf",
    normalizedPath: join(dataDir, "normalized", `${docOne}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "Unique paragraph one.",
        charStart: 0,
        charEnd: 21,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
    ],
  });
  writeManifest(manifestTwoPath, {
    docKey: docTwo,
    itemKey: "ITEMM",
    citationKey: "lee2024multi",
    title: "Doc Two",
    authors: ["B"],
    filePath: "/tmp/multi-two.pdf",
    normalizedPath: join(dataDir, "normalized", `${docTwo}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "Unique paragraph two.",
        charStart: 0,
        charEnd: 21,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [
      {
        docKey: docOne,
        itemKey: "ITEMM",
        citationKey: "lee2024multi",
        title: "Doc One",
        authors: ["A"],
        filePath: "/tmp/multi-one.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-multi-one",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${docOne}.md`),
        manifestPath: manifestOnePath,
      },
      {
        docKey: docTwo,
        itemKey: "ITEMM",
        citationKey: "lee2024multi",
        title: "Doc Two",
        authors: ["B"],
        filePath: "/tmp/multi-two.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-multi-two",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${docTwo}.md`),
        manifestPath: manifestTwoPath,
      },
    ],
  });

  const fullTextsByItemKey = fullTextDocuments(
    {
      itemKey: "ITEMM",
    },
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
  );
  const fullTextsByCitationKey = fullTextDocuments(
    {
      citationKey: "lee2024multi",
    },
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
  );

  assert.equal(fullTextsByItemKey.results.length, 2);
  assert.equal(fullTextsByCitationKey.results.length, 2);
  assert.deepEqual(
    fullTextsByItemKey.results.map((row) => row.file),
    ["/tmp/multi-one.pdf", "/tmp/multi-two.pdf"],
  );
  assert.deepEqual(
    fullTextsByCitationKey.results.map((row) => row.file),
    ["/tmp/multi-one.pdf", "/tmp/multi-two.pdf"],
  );
  assert.match(fullTextsByItemKey.results[0]!.content, /Unique paragraph one\./);
  assert.match(fullTextsByItemKey.results[1]!.content, /Unique paragraph two\./);
});

test("expandDocument rejects passing both file and citationKey", () => {
  assert.throws(
    () =>
      expandDocument(
        {
          file: "/tmp/doc.pdf",
          citationKey: "smith2024doc",
          blockStart: 0,
          blockEnd: 0,
          radius: 0,
        },
        {},
      ),
    /Provide exactly one of --file <path>, --item-key <key>, or --citation-key <key>\./,
  );
});
