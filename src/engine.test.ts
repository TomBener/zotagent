import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expandDocument, readDocument, searchLiterature } from "./engine.js";
import { writeCatalogFile } from "./state.js";
import type { AttachmentManifest, CatalogFile } from "./types.js";

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

  const fakeFactory = async () => ({
    search: async () => [
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
    ],
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
    { rerank: false },
  );

  assert.equal(capturedSearchOptions?.rerank, false);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0]!.itemKey, "ITEM1");
});

test("searchLiterature exact mode uses quoted lex query and disables rerank", async () => {
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

  let capturedSearchOptions:
    | {
        query?: string;
        queries?: Array<{ type: "lex" | "vec" | "hyde"; query: string }>;
        limit?: number;
        rerank?: boolean;
        minScore?: number;
      }
    | undefined;
  let capturedLexQuery: string | undefined;
  let capturedLexLimit: number | undefined;

  const fakeFactory = async () => ({
    search: async (options: {
      query?: string;
      queries?: Array<{ type: "lex" | "vec" | "hyde"; query: string }>;
      limit?: number;
      rerank?: boolean;
      minScore?: number;
    }) => {
      capturedSearchOptions = options;
      return [];
    },
    searchLex: async (query: string, options?: { limit?: number }) => {
      capturedLexQuery = query;
      capturedLexLimit = options?.limit;
      return [
        {
          filepath: `qmd://library/${exactDocKey}.md`,
          displayPath: `${exactDocKey}.md`,
          title: "Exact match",
          body: "The top leader is the company party secretary, dangwei shuji.",
          score: 1,
          context: null,
          docid: "999999",
        },
      ];
    },
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ documents: 1, collections: [], embeddings: { total: 1, stale: 0 } }),
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
    { exact: true },
  );

  assert.equal(capturedSearchOptions?.query, undefined);
  assert.equal(capturedLexQuery, "\"dangwei shuji\"");
  assert.equal(capturedLexLimit, 10);
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
