import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expandDocument, fullTextDocument, readDocument, searchLiterature } from "../../src/engine.js";
import { writeCatalogFile } from "../../src/state.js";
import type { AttachmentManifest, CatalogFile } from "../../src/types.js";

function writeManifest(path: string, manifest: AttachmentManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2), "utf-8");
}

test("searchLiterature prefers substantive hits over reference-only hits", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-engine-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const substantiveDocKey = "1".repeat(40);
  const referenceDocKey = "2".repeat(40);
  const substantiveManifestPath = join(manifestsDir, `${substantiveDocKey}.json`);
  const referenceManifestPath = join(manifestsDir, `${referenceDocKey}.json`);

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
  const root = mkdtempSync(join(tmpdir(), "zotlit-keyword-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const preciseDocKey = "7".repeat(40);
  const broadDocKey = "8".repeat(40);
  const preciseManifestPath = join(manifestsDir, `${preciseDocKey}.json`);
  const broadManifestPath = join(manifestsDir, `${broadDocKey}.json`);

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
  const root = mkdtempSync(join(tmpdir(), "zotlit-exact-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const exactDocKey = "9".repeat(40);
  const exactManifestPath = join(manifestsDir, `${exactDocKey}.json`);

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

test("readDocument reports multi-attachment conflict and expandDocument returns context blocks", () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-read-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docOne = "3".repeat(40);
  const docTwo = "4".repeat(40);
  const manifestOnePath = join(manifestsDir, `${docOne}.json`);
  const manifestTwoPath = join(manifestsDir, `${docTwo}.json`);

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
  const root = mkdtempSync(join(tmpdir(), "zotlit-expand-item-key-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "5".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}.json`);

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
  const root = mkdtempSync(join(tmpdir(), "zotlit-read-citation-key-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "6".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}.json`);

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

test("fullTextDocument returns cleaner markdown for agents", () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-fulltext-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "a".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}.json`);

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMA",
    citationKey: "lee2024agent",
    title: "Agent Readable Doc",
    authors: ["C"],
    filePath: "/tmp/agent.pdf",
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
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
        normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
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
  assert.equal(fullText.source, "manifest");
  assert.equal(fullText.keptBlocks, 3);
  assert.equal(fullText.skippedBoilerplateBlocks, 1);
  assert.equal(fullText.skippedDuplicateBlocks, 1);
  assert.equal(fullText.skippedReferenceBlocks, 1);
  assert.match(fullText.content, /^# Introduction/m);
  assert.match(fullText.content, /dangwei shuji/);
  assert.equal(fullText.content.match(/Party organization shapes firm governance\./g)?.length, 1);
  assert.doesNotMatch(fullText.content, /To cite this article/i);
  assert.doesNotMatch(fullText.content, /Smith, J\./);
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
