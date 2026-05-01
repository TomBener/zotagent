import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expandDocument, fullTextDocument, getDocumentBlocks, searchLiterature, searchWithinDocuments } from "../../src/engine.js";
import type { KeywordSearchOptions } from "../../src/keyword-db.js";
import { writeCatalogFile } from "../../src/state.js";
import type { AttachmentManifest, CatalogFile } from "../../src/types.js";
import { MANIFEST_EXT, writeManifestFile } from "../../src/utils.js";

function writeManifest(path: string, manifest: AttachmentManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeManifestFile(path, manifest);
}

test("searchLiterature keyword mode uses the keyword index and skips qmd", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "9".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEM9000",
    title: "Dangwei Shuji and Governance",
    authors: ["A"],
    filePath: "/tmp/keyword.pdf",
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
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
        docKey,
        itemKey: "ITEM9000",
        title: "Dangwei Shuji and Governance",
        authors: ["A"],
        filePath: "/tmp/keyword.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash9",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
        manifestPath,
      },
    ],
  });

  let qmdSearchCalled = false;
  const fakeFactory = async () => ({
    search: async () => { qmdSearchCalled = true; return []; },
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    close: async () => {},
  });

  let keywordSearchCalled = false;
  const fakeKeywordFactory = async () => ({
    rebuildIndex: async () => {},
    searchDocs: async (_query: string) => {
      keywordSearchCalled = true;
      return [{ docKey, blockIndex: 0, score: 1.5 }];
    },
    searchBlocks: async () => [],
    isEmpty: async () => false,
    close: async () => {},
  });

  const result = await searchLiterature(
    "dangwei shuji",
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
    fakeFactory,
    {},
    fakeKeywordFactory,
  );

  assert.equal(qmdSearchCalled, false);
  assert.equal(keywordSearchCalled, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]!.itemKey, "ITEM9000");
  assert.match(result.results[0]!.passage, /dangwei shuji/i);
});

test("searchLiterature keyword mode restricts searches to filtered item keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-tag-filter-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const taggedDocKey = "a".repeat(40);
  const otherDocKey = "b".repeat(40);
  const taggedManifestPath = join(manifestsDir, `${taggedDocKey}${MANIFEST_EXT}`);
  const otherManifestPath = join(manifestsDir, `${otherDocKey}${MANIFEST_EXT}`);

  writeManifest(taggedManifestPath, {
    docKey: taggedDocKey,
    itemKey: "TAGGED01",
    title: "Tagged thesis",
    authors: ["A"],
    filePath: "/tmp/tagged.pdf",
    normalizedPath: join(dataDir, "normalized", `${taggedDocKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "This thesis discusses local fiscal capacity.",
        charStart: 0,
        charEnd: 43,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
    ],
  });
  writeManifest(otherManifestPath, {
    docKey: otherDocKey,
    itemKey: "OTHER001",
    title: "Other article",
    authors: ["B"],
    filePath: "/tmp/other.pdf",
    normalizedPath: join(dataDir, "normalized", `${otherDocKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "This article also discusses local fiscal capacity.",
        charStart: 0,
        charEnd: 49,
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
        docKey: taggedDocKey,
        itemKey: "TAGGED01",
        title: "Tagged thesis",
        authors: ["A"],
        filePath: "/tmp/tagged.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-tagged",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${taggedDocKey}.md`),
        manifestPath: taggedManifestPath,
      },
      {
        docKey: otherDocKey,
        itemKey: "OTHER001",
        title: "Other article",
        authors: ["B"],
        filePath: "/tmp/other.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-other",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${otherDocKey}.md`),
        manifestPath: otherManifestPath,
      },
    ],
  });

  let capturedOptions: KeywordSearchOptions | undefined;
  const fakeKeywordFactory = async () => ({
    rebuildIndex: async () => {},
    searchDocs: async (_query: string, _limit: number, options?: KeywordSearchOptions) => {
      capturedOptions = options;
      return [{ docKey: taggedDocKey, blockIndex: 0, score: 2 }];
    },
    searchBlocks: async () => [],
    isEmpty: async () => false,
    close: async () => {},
  });
  const unusedQmdFactory = async () => {
    throw new Error("qmd search should not run in keyword mode");
  };

  const result = await searchLiterature(
    "local fiscal capacity",
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
    unusedQmdFactory,
    { itemKeys: ["TAGGED01"] },
    fakeKeywordFactory,
  );

  assert.deepEqual(capturedOptions?.docKeys, [taggedDocKey]);
  assert.deepEqual(
    result.results.map((row) => row.itemKey),
    ["TAGGED01"],
  );
});

test("searchLiterature keyword mode anchors long-block passages on the matched query", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-long-anchor-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "8".repeat(40);
  const manifestPath = join(manifestsDir, docKey + MANIFEST_EXT);
  const text = `needle ${"x".repeat(2000)}`;

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMKANC",
    title: "Long keyword block",
    authors: ["A"],
    filePath: "/tmp/long-keyword.pdf",
    normalizedPath: join(dataDir, "normalized", docKey + ".md"),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text,
        charStart: 0,
        charEnd: text.length,
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
        docKey,
        itemKey: "ITEMKANC",
        title: "Long keyword block",
        authors: ["A"],
        filePath: "/tmp/long-keyword.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-long-keyword",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", docKey + ".md"),
        manifestPath,
      },
    ],
  });

  const fakeKeywordFactory = async () => ({
    rebuildIndex: async () => {},
    searchDocs: async (_query: string) => [{ docKey, blockIndex: 0, score: 1.5 }],
    searchBlocks: async () => [],
    isEmpty: async () => false,
    close: async () => {},
  });
  const unusedQmdFactory = async () => {
    throw new Error("qmd search should not run in keyword mode");
  };

  const result = await searchLiterature(
    "needle",
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
    unusedQmdFactory,
    {},
    fakeKeywordFactory,
  );

  assert.equal(result.results.length, 1);
  assert.match(result.results[0]!.passage, /needle/);
  assert.ok(result.results[0]!.charOffset < 20, `charOffset ${result.results[0]!.charOffset} should anchor near the hit`);
});

test("searchLiterature semantic mode anchors long-block passages on the best chunk", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-semantic-long-anchor-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "7".repeat(40);
  const manifestPath = join(manifestsDir, docKey + MANIFEST_EXT);
  const bestChunk = "semantic-anchor";
  const text = `${bestChunk} ${"x".repeat(2000)}`;

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMSANC",
    title: "Long semantic block",
    authors: ["A"],
    filePath: "/tmp/long-semantic.pdf",
    normalizedPath: join(dataDir, "normalized", docKey + ".md"),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text,
        charStart: 0,
        charEnd: text.length,
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
        docKey,
        itemKey: "ITEMSANC",
        title: "Long semantic block",
        authors: ["A"],
        filePath: "/tmp/long-semantic.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-long-semantic",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", docKey + ".md"),
        manifestPath,
      },
    ],
  });

  const fakeQmdFactory = async () => ({
    search: async () => [{
      file: `qmd://library/${docKey}.md`,
      displayPath: `qmd://library/${docKey}.md`,
      bestChunk,
      bestChunkPos: 0,
      score: 0.9,
    }],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });

  const result = await searchLiterature(
    "semantic query",
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
    fakeQmdFactory,
    { semantic: true },
  );

  assert.equal(result.results.length, 1);
  assert.match(result.results[0]!.passage, /semantic-anchor/);
  assert.ok(result.results[0]!.charOffset < 20, `charOffset ${result.results[0]!.charOffset} should anchor near the best chunk`);
});

test("searchLiterature keyword mode bootstraps a missing keyword index from existing manifests", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-bootstrap-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "b".repeat(40);
  const manifestPath = join(manifestsDir, docKey + MANIFEST_EXT);

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMB000",
    title: "Ageing in China",
    authors: ["A"],
    filePath: "/tmp/bootstrap.pdf",
    normalizedPath: join(dataDir, "normalized", docKey + ".md"),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "Population ageing in China is reshaping care arrangements.",
        charStart: 0,
        charEnd: 58,
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
        docKey,
        itemKey: "ITEMB000",
        title: "Ageing in China",
        authors: ["A"],
        filePath: "/tmp/bootstrap.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-bootstrap",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", docKey + ".md"),
        manifestPath,
      },
    ],
  });

  const result = await searchLiterature(
    "ageing",
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
  );

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]!.itemKey, "ITEMB000");
  assert.match(result.results[0]!.passage, /ageing in china/i);
});

test("searchLiterature keyword mode maps stemmed hits to the matching block", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-stemmed-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "c".repeat(40);
  const manifestPath = join(manifestsDir, docKey + MANIFEST_EXT);

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMC000",
    title: "Governance Study",
    authors: ["A"],
    filePath: "/tmp/stemmed.pdf",
    normalizedPath: join(dataDir, "normalized", docKey + ".md"),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Intro"],
        text: "Nothing useful here.",
        charStart: 0,
        charEnd: 20,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
      {
        blockIndex: 1,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "The party secretary governs recruitment.",
        charStart: 21,
        charEnd: 62,
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
        itemKey: "ITEMC000",
        title: "Governance Study",
        authors: ["A"],
        filePath: "/tmp/stemmed.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-stemmed",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", docKey + ".md"),
        manifestPath,
      },
    ],
  });

  const result = await searchLiterature(
    "governing",
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
  );

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]!.itemKey, "ITEMC000");
  assert.match(result.results[0]!.passage, /governs recruitment/i);
});

test("searchLiterature keyword mode matches spaced CJK content via NEAR rewriting", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-cjk-spacing-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "f".repeat(40);
  const manifestPath = join(manifestsDir, docKey + MANIFEST_EXT);

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMF000",
    title: "干部岗位研究",
    authors: ["A"],
    filePath: "/tmp/cjk-spacing.pdf",
    normalizedPath: join(dataDir, "normalized", docKey + ".md"),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "党 委 书 记 是 干 部 体 系 中 的 关 键 岗 位。",
        charStart: 0,
        charEnd: 24,
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
        docKey,
        itemKey: "ITEMF000",
        title: "干部岗位研究",
        authors: ["A"],
        filePath: "/tmp/cjk-spacing.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-cjk-spacing",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", docKey + ".md"),
        manifestPath,
      },
    ],
  });

  const fakeKeywordFactory = async () => ({
    rebuildIndex: async () => {},
    searchDocs: async (_query: string) => [{ docKey, blockIndex: 0, score: 1.5 }],
    isEmpty: async () => false,
    close: async () => {},
  });
  const unusedQmdFactory = async () => {
    throw new Error("qmd search should not run in keyword mode");
  };

  const result = await searchLiterature(
    "党委书记",
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
    unusedQmdFactory,
    {},
    fakeKeywordFactory,
  );

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]!.itemKey, "ITEMF000");
  assert.match(result.results[0]!.passage, /党 委 书 记/u);
});

test("searchLiterature keyword mode verifies a traditional query against a simplified document", async () => {
  // Regression: the FTS layer folds trad → simp, but the passage verifier's query profile
  // used the raw query and produced traditional terms that never matched the simplified
  // normalized haystack, so cross-script hits were silently dropped.
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-trad-simp-e2e-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "2".repeat(40);
  const manifestPath = join(manifestsDir, docKey + MANIFEST_EXT);

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMTS00",
    title: "开发新疆研究",
    authors: ["A"],
    filePath: "/tmp/cjk-trad-simp.pdf",
    normalizedPath: join(dataDir, "normalized", docKey + ".md"),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "本文讨论开发新疆的人力财力问题。",
        charStart: 0,
        charEnd: 20,
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
        docKey,
        itemKey: "ITEMTS00",
        title: "开发新疆研究",
        authors: ["A"],
        filePath: "/tmp/cjk-trad-simp.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-cjk-trad-simp",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", docKey + ".md"),
        manifestPath,
      },
    ],
  });

  const fakeKeywordFactory = async () => ({
    rebuildIndex: async () => {},
    searchDocs: async (_query: string) => [{ docKey, blockIndex: 0, score: 1.5 }],
    isEmpty: async () => false,
    close: async () => {},
  });
  const unusedQmdFactory = async () => {
    throw new Error("qmd search should not run in keyword mode");
  };

  // OR-query in traditional Chinese — every CJK term changes under trad→simp folding.
  const result = await searchLiterature(
    "開發 OR 財力",
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
    unusedQmdFactory,
    {},
    fakeKeywordFactory,
  );

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]!.itemKey, "ITEMTS00");
  assert.match(result.results[0]!.passage, /开发新疆/u);
});

test("searchLiterature NEAR/N picks the CJK co-occurrence block, not a distance decoy", async () => {
  // Regression guard for passage scoring: the public proximity syntax must keep only
  // content terms for block selection, and CJK terms must match as substrings.
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-near-passage-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "1".repeat(40);
  const manifestPath = join(manifestsDir, docKey + MANIFEST_EXT);

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMNEAR",
    title: "抗戰時期新疆建設",
    authors: ["A"],
    filePath: "/tmp/near-decoy.pdf",
    normalizedPath: join(dataDir, "normalized", docKey + ".md"),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Front"],
        text: "50 52 54 54",
        charStart: 0,
        charEnd: 11,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
      {
        blockIndex: 1,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "欢迎英美人力财力开发新疆;请中央交涉。",
        charStart: 13,
        charEnd: 31,
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
        itemKey: "ITEMNEAR",
        title: "抗戰時期新疆建設",
        authors: ["A"],
        filePath: "/tmp/near-decoy.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-near",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", docKey + ".md"),
        manifestPath,
      },
    ],
  });

  const fakeKeywordFactory = async () => ({
    rebuildIndex: async () => {},
    searchDocs: async (_query: string) => [{ docKey, blockIndex: 1, score: 1.5 }],
    isEmpty: async () => false,
    close: async () => {},
  });
  const unusedQmdFactory = async () => {
    throw new Error("qmd search should not run in keyword mode");
  };

  const result = await searchLiterature(
    '"开发新疆" NEAR/50 "人力财力"',
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
    unusedQmdFactory,
    {},
    fakeKeywordFactory,
  );

  assert.equal(result.results.length, 1);
  assert.match(result.results[0]!.passage, /人力财力开发新疆/u);
  // The hit anchor (charOffset) must land inside block 1 (charStart=13..charEnd=31),
  // not block 0 ("50 52 54 54", charStart=0..charEnd=11).
  assert.ok(
    result.results[0]!.charOffset >= 13 && result.results[0]!.charOffset <= 31,
    `charOffset ${result.results[0]!.charOffset} must point at the CJK block, not the numeric decoy`,
  );
});

test("searchLiterature keeps AND/NEAR inside a quoted literal phrase for passage selection", async () => {
  // Regression: stripFtsOperators used to strip AND/OR/NOT/NEAR unconditionally, including
  // inside quotes. That made normalizedQuery="black white" for a `"black AND white"` query,
  // so findExactPhraseBlockRange could not find the real phrase block and passage selection
  // fell back to term scoring, which could pick any block containing both tokens.
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-quoted-and-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "3".repeat(40);
  const manifestPath = join(manifestsDir, docKey + MANIFEST_EXT);

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMAND0",
    title: "Contrast Study",
    authors: ["A"],
    filePath: "/tmp/quoted-and.pdf",
    normalizedPath: join(dataDir, "normalized", docKey + ".md"),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Decoy"],
        text: "black or gray and white text appears elsewhere.",
        charStart: 0,
        charEnd: 47,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
      {
        blockIndex: 1,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "photos were printed in black and white in the early edition.",
        charStart: 49,
        charEnd: 109,
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
        itemKey: "ITEMAND0",
        title: "Contrast Study",
        authors: ["A"],
        filePath: "/tmp/quoted-and.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-quoted-and",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", docKey + ".md"),
        manifestPath,
      },
    ],
  });

  const fakeKeywordFactory = async () => ({
    rebuildIndex: async () => {},
    searchDocs: async (_query: string) => [{ docKey, blockIndex: 1, score: 1.5 }],
    isEmpty: async () => false,
    close: async () => {},
  });
  const unusedQmdFactory = async () => {
    throw new Error("qmd search should not run in keyword mode");
  };

  const result = await searchLiterature(
    '"black AND white"',
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
    unusedQmdFactory,
    {},
    fakeKeywordFactory,
  );

  assert.equal(result.results.length, 1);
  assert.match(result.results[0]!.passage, /black and white/u);
});

test("searchLiterature does not rebuild the keyword index when empty results come from a populated index", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-no-rebuild-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "2".repeat(40);
  const manifestPath = join(manifestsDir, docKey + MANIFEST_EXT);

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMNR00",
    title: "Populated",
    authors: ["A"],
    filePath: "/tmp/no-rebuild.pdf",
    normalizedPath: join(dataDir, "normalized", docKey + ".md"),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "anything here.",
        charStart: 0,
        charEnd: 14,
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
        docKey,
        itemKey: "ITEMNR00",
        title: "Populated",
        authors: ["A"],
        filePath: "/tmp/no-rebuild.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-no-rebuild",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", docKey + ".md"),
        manifestPath,
      },
    ],
  });

  let rebuildCalled = false;
  const fakeKeywordFactory = async () => ({
    rebuildIndex: async () => { rebuildCalled = true; },
    searchDocs: async (_query: string) => [],
    isEmpty: async () => false,
    close: async () => {},
  });
  const unusedQmdFactory = async () => {
    throw new Error("qmd search should not run in keyword mode");
  };

  const result = await searchLiterature(
    "nothing matches",
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
    unusedQmdFactory,
    {},
    fakeKeywordFactory,
  );

  assert.equal(rebuildCalled, false);
  assert.equal(result.results.length, 0);
});

test("searchWithinDocuments returns passages from the selected attachment", async () => {
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
    itemKey: "ITEMS000",
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
        itemKey: "ITEMS000",
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

  const fakeKeywordFactory = async () => ({
    rebuildIndex: async () => {},
    searchDocs: async (_query: string, _limit: number, options?: { docKeys?: string[] }) =>
      (options?.docKeys ?? [docKey]).map((k) => ({ docKey: k, blockIndex: 1, score: 1 })),
    searchBlocks: async (_query: string, _limit: number, options?: { docKeys?: string[] }) =>
      (options?.docKeys ?? [docKey]).map((k) => ({ docKey: k, blockIndex: 1, score: 1 })),
    isEmpty: async () => false,
    close: async () => {},
  });

  const result = await searchWithinDocuments(
    "dangwei shuji",
    { key: "ITEMS000" },
    10,
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
    fakeKeywordFactory,
  );

  assert.equal(result.results.length > 0, true);
  assert.equal(result.results[0]!.itemKey, "ITEMS000");
  assert.match(result.results[0]!.passage, /dangwei shuji/i);
});

test("searchWithinDocuments searches across multiple attachments for the same key", async () => {
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
    itemKey: "ITEMS000",
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
    itemKey: "ITEMS000",
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
        itemKey: "ITEMS000",
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
        itemKey: "ITEMS000",
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

  const fakeKeywordFactory = async () => ({
    rebuildIndex: async () => {},
    searchDocs: async (_query: string, _limit: number, options?: { docKeys?: string[] }) =>
      (options?.docKeys ?? [docOne, docTwo]).map((k) => ({ docKey: k, blockIndex: 0, score: 1 })),
    searchBlocks: async (_query: string, _limit: number, options?: { docKeys?: string[] }) =>
      (options?.docKeys ?? [docOne, docTwo]).map((k) => ({ docKey: k, blockIndex: 0, score: 1 })),
    isEmpty: async () => false,
    close: async () => {},
  });

  const result = await searchWithinDocuments(
    "unique paragraph",
    { key: "ITEMS000" },
    10,
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
    fakeKeywordFactory,
  );

  assert.equal(result.results.length, 2);
  for (const row of result.results) {
    assert.equal("file" in row, false);
  }
  assert.ok(
    result.results[1]!.charOffset > result.results[0]!.charOffset,
    "second attachment's char offset should sit past the merged separator",
  );
});

test("searchWithinDocuments honors NEAR/AND/OR operators via FTS", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-search-in-near-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "n".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMN000",
    title: "NEAR Test Doc",
    authors: ["A"],
    filePath: "/tmp/near.pdf",
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "alpha and beta sit close together here.",
        charStart: 0, charEnd: 39, lineStart: 1, lineEnd: 1, isReferenceLike: false,
      },
      {
        blockIndex: 1,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "alpha appears here without beta nearby anywhere in this paragraph.",
        charStart: 41, charEnd: 110, lineStart: 3, lineEnd: 3, isReferenceLike: false,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [{
      docKey, itemKey: "ITEMN000", title: "NEAR Test Doc", authors: ["A"],
      filePath: "/tmp/near.pdf", fileExt: "pdf", exists: true, supported: true,
      extractStatus: "ready", size: 1, mtimeMs: 1, sourceHash: "hash-near",
      lastIndexedAt: new Date().toISOString(),
      normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
      manifestPath,
    }],
  });

  // Real keyword index — exercises FTS NEAR end-to-end.
  const proximate = await searchWithinDocuments(
    'alpha NEAR/3 beta',
    { key: "ITEMN000" },
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
  );
  assert.equal(proximate.results.length > 0, true, "NEAR/3 should match the doc");

  // The doc has alpha+beta within proximity, so it should match. A NEAR/3 that
  // a doc cannot satisfy at all returns zero results.
  const impossibleNear = await searchWithinDocuments(
    'gamma NEAR/3 delta',
    { key: "ITEMN000" },
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
  );
  assert.equal(impossibleNear.results.length, 0);

  // OR operator
  const orResult = await searchWithinDocuments(
    'alpha OR gamma',
    { key: "ITEMN000" },
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
  );
  assert.equal(orResult.results.length > 0, true);
});

test("searchWithinDocuments AND requires every term in each ranked block", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-search-in-and-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "a".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMA000",
    title: "AND test",
    authors: ["A"],
    filePath: "/tmp/and.pdf",
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    blocks: [
      {
        blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
        text: "alpha alpha alpha alpha alpha repeats here without the other term.",
        charStart: 0, charEnd: 65, lineStart: 1, lineEnd: 1, isReferenceLike: false,
      },
      {
        blockIndex: 1, blockType: "paragraph", sectionPath: ["Body"],
        text: "Here both alpha and beta appear together exactly once.",
        charStart: 67, charEnd: 121, lineStart: 3, lineEnd: 3, isReferenceLike: false,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [{
      docKey, itemKey: "ITEMA000", title: "AND test", authors: ["A"],
      filePath: "/tmp/and.pdf", fileExt: "pdf", exists: true, supported: true,
      extractStatus: "ready", size: 1, mtimeMs: 1, sourceHash: "hash-and",
      lastIndexedAt: new Date().toISOString(),
      normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
      manifestPath,
    }],
  });

  const result = await searchWithinDocuments(
    'alpha AND beta',
    { key: "ITEMA000" },
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
  );
  // The all-alpha block must not appear; only the alpha+beta block should.
  assert.equal(result.results.length, 1);
  assert.match(result.results[0]!.passage, /alpha and beta appear together/);
});

test("searchWithinDocuments AND with quoted phrases requires every phrase token in each block", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-search-in-quoted-and-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "q".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMQ000",
    title: "Quoted AND",
    authors: ["A"],
    filePath: "/tmp/qand.pdf",
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    blocks: [
      {
        blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
        text: "property rights are central to development without other framing.",
        charStart: 0, charEnd: 64, lineStart: 1, lineEnd: 1, isReferenceLike: false,
      },
      {
        blockIndex: 1, blockType: "paragraph", sectionPath: ["Body"],
        text: "Credible commitment to property rights builds long-run institutions.",
        charStart: 66, charEnd: 130, lineStart: 3, lineEnd: 3, isReferenceLike: false,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [{
      docKey, itemKey: "ITEMQ000", title: "Quoted AND", authors: ["A"],
      filePath: "/tmp/qand.pdf", fileExt: "pdf", exists: true, supported: true,
      extractStatus: "ready", size: 1, mtimeMs: 1, sourceHash: "hash-qand",
      lastIndexedAt: new Date().toISOString(),
      normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
      manifestPath,
    }],
  });

  const result = await searchWithinDocuments(
    '"property rights" AND "credibility"',
    { key: "ITEMQ000" },
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
  );
  // Only the second block has both "property rights" and a credibility-stem
  // word ("credible"). The first block must not appear.
  assert.equal(result.results.length, 1);
  assert.match(result.results[0]!.passage, /Credible commitment to property rights/);
});

test("searchWithinDocuments NOT does not gate on attachment title", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-search-in-not-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "b".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);

  // Title contains "Beta" but body never mentions beta. With body-only FTS, the
  // doc must still satisfy `alpha NOT beta` because the gate only inspects body.
  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMB000",
    title: "Beta in the title only",
    authors: ["A"],
    filePath: "/tmp/not.pdf",
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    blocks: [
      {
        blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
        text: "alpha appears here without the other word anywhere.",
        charStart: 0, charEnd: 51, lineStart: 1, lineEnd: 1, isReferenceLike: false,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [{
      docKey, itemKey: "ITEMB000", title: "Beta in the title only", authors: ["A"],
      filePath: "/tmp/not.pdf", fileExt: "pdf", exists: true, supported: true,
      extractStatus: "ready", size: 1, mtimeMs: 1, sourceHash: "hash-not",
      lastIndexedAt: new Date().toISOString(),
      normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
      manifestPath,
    }],
  });

  const result = await searchWithinDocuments(
    'alpha NOT beta',
    { key: "ITEMB000" },
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
  );
  assert.equal(result.results.length, 1);
  assert.match(result.results[0]!.passage, /alpha appears here without/);
});

test("searchWithinDocuments NOT phrase keeps blocks that contain only one of the phrase tokens", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-search-in-not-phrase-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "p".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);

  // Single-block body so the FTS-level NOT doesn't reject the whole doc on
  // unrelated grounds. The block itself contains alpha and beta but never the
  // adjacent phrase "beta gamma" — the constraint analyzer must treat the
  // negative phrase as a unit (substring check), not as decomposed stems.
  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMP000",
    title: "NOT phrase",
    authors: ["A"],
    filePath: "/tmp/notphrase.pdf",
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    blocks: [
      {
        blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
        text: "alpha and beta are mentioned together without the third word.",
        charStart: 0, charEnd: 60, lineStart: 1, lineEnd: 1, isReferenceLike: false,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [{
      docKey, itemKey: "ITEMP000", title: "NOT phrase", authors: ["A"],
      filePath: "/tmp/notphrase.pdf", fileExt: "pdf", exists: true, supported: true,
      extractStatus: "ready", size: 1, mtimeMs: 1, sourceHash: "hash-notphrase",
      lastIndexedAt: new Date().toISOString(),
      normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
      manifestPath,
    }],
  });

  const result = await searchWithinDocuments(
    'alpha NOT "beta gamma"',
    { key: "ITEMP000" },
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
  );
  // Block 0 must survive (no "beta gamma" phrase). Block 1 must be excluded.
  assert.equal(result.results.length, 1);
  assert.match(result.results[0]!.passage, /alpha and beta are mentioned together/);
});

test("searchWithinDocuments positive phrase requires the literal phrase, not its tokens scattered", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-search-in-pos-phrase-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "r".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMR000",
    title: "Positive phrase",
    authors: ["A"],
    filePath: "/tmp/posphrase.pdf",
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    blocks: [
      {
        // Contains alpha and beta separated by other words — must NOT match
        // `"alpha beta"`.
        blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
        text: "alpha foo bar baz quux beta scattered across the sentence.",
        charStart: 0, charEnd: 58, lineStart: 1, lineEnd: 1, isReferenceLike: false,
      },
      {
        // Contains the exact substring "alpha beta" — must match.
        blockIndex: 1, blockType: "paragraph", sectionPath: ["Body"],
        text: "Here the literal phrase alpha beta appears together.",
        charStart: 60, charEnd: 110, lineStart: 3, lineEnd: 3, isReferenceLike: false,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [{
      docKey, itemKey: "ITEMR000", title: "Positive phrase", authors: ["A"],
      filePath: "/tmp/posphrase.pdf", fileExt: "pdf", exists: true, supported: true,
      extractStatus: "ready", size: 1, mtimeMs: 1, sourceHash: "hash-posphrase",
      lastIndexedAt: new Date().toISOString(),
      normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
      manifestPath,
    }],
  });

  const result = await searchWithinDocuments(
    '"alpha beta"',
    { key: "ITEMR000" },
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
  );
  assert.ok(result.results.length >= 1);
  assert.match(result.results[0]!.passage, /literal phrase alpha beta/);

  const missingPrefix = await searchWithinDocuments(
    '"lpha beta"',
    { key: "ITEMR000" },
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
  );
  assert.equal(missingPrefix.results.length, 0, "quoted phrases must not match inside the first token");

  const missingSuffix = await searchWithinDocuments(
    '"alpha bet"',
    { key: "ITEMR000" },
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
  );
  assert.equal(missingSuffix.results.length, 0, "quoted phrases must not match inside the last token");
});

test("searchWithinDocuments finds quoted CJK phrases across block boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-search-in-cjk-cross-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "v".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMV000",
    title: "CJK cross-block phrase",
    authors: ["A"],
    filePath: "/tmp/cjk-cross.pdf",
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    blocks: [
      {
        blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
        text: "本文讨论开发",
        charStart: 0, charEnd: 6, lineStart: 1, lineEnd: 1, isReferenceLike: false,
      },
      {
        blockIndex: 1, blockType: "paragraph", sectionPath: ["Body"],
        text: "新疆的人力财力问题。",
        charStart: 8, charEnd: 18, lineStart: 3, lineEnd: 3, isReferenceLike: false,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [{
      docKey, itemKey: "ITEMV000", title: "CJK cross-block phrase", authors: ["A"],
      filePath: "/tmp/cjk-cross.pdf", fileExt: "pdf", exists: true, supported: true,
      extractStatus: "ready", size: 1, mtimeMs: 1, sourceHash: "hash-cjk-cross",
      lastIndexedAt: new Date().toISOString(),
      normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
      manifestPath,
    }],
  });

  const result = await searchWithinDocuments(
    '"开发新疆"',
    { key: "ITEMV000" },
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
  );

  assert.equal(result.results.length, 1);
  assert.match(result.results[0]!.passage, /开发\n\n新疆/u);
});

test("searchWithinDocuments NOT does not resurface blocks via cross-block phrase scan", async () => {
  // Repro from Codex review: stripping operators turns `alpha NOT beta` into
  // the substring `alpha beta`. The previous code happily ran the cross-block
  // exact-phrase scan on that stripped form and returned a block FTS5 had
  // legitimately excluded. The cross-block scan is now gated to single quoted
  // phrase queries only.
  const root = mkdtempSync(join(tmpdir(), "zotagent-search-in-not-cross-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "z".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);

  writeManifest(manifestPath, {
    docKey, itemKey: "ITEMZ000", title: "NOT cross", authors: ["A"],
    filePath: "/tmp/notcross.pdf",
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    blocks: [
      {
        // Contains literal "alpha beta" — must be excluded by NOT beta.
        blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
        text: "Here alpha beta appears together exactly once in this paragraph.",
        charStart: 0, charEnd: 64, lineStart: 1, lineEnd: 1, isReferenceLike: false,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [{
      docKey, itemKey: "ITEMZ000", title: "NOT cross", authors: ["A"],
      filePath: "/tmp/notcross.pdf", fileExt: "pdf", exists: true, supported: true,
      extractStatus: "ready", size: 1, mtimeMs: 1, sourceHash: "hash-notcross",
      lastIndexedAt: new Date().toISOString(),
      normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
      manifestPath,
    }],
  });

  const result = await searchWithinDocuments(
    'alpha NOT beta',
    { key: "ITEMZ000" },
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
  );
  assert.equal(result.results.length, 0, "block containing alpha beta must be excluded by NOT");
});

test("searchWithinDocuments cross-block phrase scan only runs for a single quoted phrase", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-search-in-multi-phrase-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "w".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);

  // The block contains the substring "alpha beta gamma" but does NOT have
  // both quoted phrases as required by `"alpha beta" AND "delta epsilon"`.
  // The cross-block scan would otherwise concatenate the stripped query into
  // "alpha beta delta epsilon" — present nowhere — but if it had naively
  // matched the first phrase alone it could over-claim. Verify nothing
  // surfaces and the FTS gate alone decides.
  writeManifest(manifestPath, {
    docKey, itemKey: "ITEMW000", title: "Multi phrase", authors: ["A"],
    filePath: "/tmp/multi.pdf",
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    blocks: [
      {
        blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
        text: "alpha beta gamma in one sentence with no other relevant tokens.",
        charStart: 0, charEnd: 63, lineStart: 1, lineEnd: 1, isReferenceLike: false,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [{
      docKey, itemKey: "ITEMW000", title: "Multi phrase", authors: ["A"],
      filePath: "/tmp/multi.pdf", fileExt: "pdf", exists: true, supported: true,
      extractStatus: "ready", size: 1, mtimeMs: 1, sourceHash: "hash-multi",
      lastIndexedAt: new Date().toISOString(),
      normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
      manifestPath,
    }],
  });

  const result = await searchWithinDocuments(
    '"alpha beta" AND "delta epsilon"',
    { key: "ITEMW000" },
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
  );
  assert.equal(result.results.length, 0, "FTS gate alone decides; cross-block scan must not fire");
});

test("searchWithinDocuments NEAR returns empty when terms straddle block boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-search-in-cross-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "x".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);

  // FTS5 NEAR is positional within a single FTS row. The per-block index
  // stores one row per block, so terms that appear in different blocks
  // never satisfy NEAR. This test pins the honest behavior — no fabricated
  // cross-block "fallback" hit, since FTS itself cannot prove the proximity.
  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMX000",
    title: "Cross-block",
    authors: ["A"],
    filePath: "/tmp/cross.pdf",
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    blocks: [
      {
        blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
        text: "Discussion of alpha as a topic in this paragraph only.",
        charStart: 0, charEnd: 54, lineStart: 1, lineEnd: 1, isReferenceLike: false,
      },
      {
        blockIndex: 1, blockType: "paragraph", sectionPath: ["Body"],
        text: "Now beta becomes the focus in a new paragraph.",
        charStart: 56, charEnd: 102, lineStart: 3, lineEnd: 3, isReferenceLike: false,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [{
      docKey, itemKey: "ITEMX000", title: "Cross-block", authors: ["A"],
      filePath: "/tmp/cross.pdf", fileExt: "pdf", exists: true, supported: true,
      extractStatus: "ready", size: 1, mtimeMs: 1, sourceHash: "hash-cross",
      lastIndexedAt: new Date().toISOString(),
      normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
      manifestPath,
    }],
  });

  const result = await searchWithinDocuments(
    'alpha NEAR/10 beta',
    { key: "ITEMX000" },
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
  );
  assert.equal(result.results.length, 0);
});

test("searchWithinDocuments OR with phrase requires each branch to actually match", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-search-in-or-phrase-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "o".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMO000",
    title: "OR phrase",
    authors: ["A"],
    filePath: "/tmp/orphrase.pdf",
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    blocks: [
      {
        // Has alpha and beta scattered, no contiguous phrase, no gamma — must
        // NOT satisfy `"alpha beta" OR gamma`.
        blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
        text: "alpha appears here and beta arrives later in the same paragraph.",
        charStart: 0, charEnd: 65, lineStart: 1, lineEnd: 1, isReferenceLike: false,
      },
      {
        // Contains gamma — must satisfy via the second OR branch.
        blockIndex: 1, blockType: "paragraph", sectionPath: ["Body"],
        text: "gamma is the focus of this distinct paragraph.",
        charStart: 67, charEnd: 113, lineStart: 3, lineEnd: 3, isReferenceLike: false,
      },
      {
        // Contains the literal phrase "alpha beta" — must satisfy via first
        // OR branch.
        blockIndex: 2, blockType: "paragraph", sectionPath: ["Body"],
        text: "Here the literal alpha beta phrase appears once.",
        charStart: 115, charEnd: 162, lineStart: 5, lineEnd: 5, isReferenceLike: false,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [{
      docKey, itemKey: "ITEMO000", title: "OR phrase", authors: ["A"],
      filePath: "/tmp/orphrase.pdf", fileExt: "pdf", exists: true, supported: true,
      extractStatus: "ready", size: 1, mtimeMs: 1, sourceHash: "hash-orphrase",
      lastIndexedAt: new Date().toISOString(),
      normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
      manifestPath,
    }],
  });

  const result = await searchWithinDocuments(
    '"alpha beta" OR gamma',
    { key: "ITEMO000" },
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
  );
  // Block 0 (scattered alpha/beta, no gamma) must not appear. Blocks 1 and 2
  // both satisfy a branch and should appear.
  const offsets = result.results.map((r) => r.charOffset);
  assert.equal(offsets.some((offset) => offset >= 0 && offset <= 65), false, "scattered alpha/beta block must be excluded");
  assert.equal(offsets.some((offset) => offset >= 67 && offset <= 113), true, "gamma-only block must appear");
  assert.equal(offsets.some((offset) => offset >= 115 && offset <= 162), true, "literal alpha beta block must appear");
});

test("searchWithinDocuments OR+NOT enforces NOT inside each branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-search-in-or-not-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "y".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);

  // Each block tests one branch of `alpha NOT delta OR beta`:
  //  - block 0: alpha + delta → first branch fails (delta excluded), no beta
  //  - block 1: alpha alone → first branch passes
  //  - block 2: beta alone → second branch passes
  //  - block 3: only delta → both branches fail
  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEMY000",
    title: "OR NOT",
    authors: ["A"],
    filePath: "/tmp/ornot.pdf",
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    blocks: [
      {
        blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
        text: "alpha and delta show up together here without the third word.",
        charStart: 0, charEnd: 60, lineStart: 1, lineEnd: 1, isReferenceLike: false,
      },
      {
        blockIndex: 1, blockType: "paragraph", sectionPath: ["Body"],
        text: "alpha appears alone in this paragraph as the sole keyword.",
        charStart: 62, charEnd: 120, lineStart: 3, lineEnd: 3, isReferenceLike: false,
      },
      {
        blockIndex: 2, blockType: "paragraph", sectionPath: ["Body"],
        text: "beta is the only relevant token in this entire paragraph here.",
        charStart: 122, charEnd: 184, lineStart: 5, lineEnd: 5, isReferenceLike: false,
      },
      {
        blockIndex: 3, blockType: "paragraph", sectionPath: ["Body"],
        text: "delta exists here in isolation with no other related keywords.",
        charStart: 186, charEnd: 248, lineStart: 7, lineEnd: 7, isReferenceLike: false,
      },
    ],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [{
      docKey, itemKey: "ITEMY000", title: "OR NOT", authors: ["A"],
      filePath: "/tmp/ornot.pdf", fileExt: "pdf", exists: true, supported: true,
      extractStatus: "ready", size: 1, mtimeMs: 1, sourceHash: "hash-ornot",
      lastIndexedAt: new Date().toISOString(),
      normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
      manifestPath,
    }],
  });

  const result = await searchWithinDocuments(
    'alpha NOT delta OR beta',
    { key: "ITEMY000" },
    10,
    { bibliographyJsonPath: join(root, "bibliography.json"), attachmentsRoot: root, dataDir },
  );
  const offsets = result.results.map((r) => r.charOffset);
  assert.equal(offsets.some((offset) => offset >= 62 && offset <= 120), true, "alpha-only block satisfies first branch");
  assert.equal(offsets.some((offset) => offset >= 122 && offset <= 184), true, "beta-only block satisfies second branch");
  assert.equal(offsets.some((offset) => offset >= 0 && offset <= 60), false, "alpha+delta block must be excluded by NOT");
  assert.equal(offsets.some((offset) => offset >= 186 && offset <= 248), false, "delta-only block satisfies neither branch");
});

test("getDocumentBlocks merges multi-attachment itemKey and expandDocument uses item-global blocks", () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-blocks-"));
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
    itemKey: "ITEM1000",
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
    itemKey: "ITEM1000",
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
        itemKey: "ITEM1000",
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
        itemKey: "ITEM1000",
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

  const blocks = getDocumentBlocks(
    {
      key: "ITEM1000",
      offsetBlock: 0,
      limitBlocks: 20,
    },
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
  );

  assert.deepEqual(blocks.files, ["/tmp/doc-one.pdf", "/tmp/doc-two.pdf"]);
  // Doc One has 3 blocks (0..2). Block 3 is the "Attachment: doc-two.pdf" separator.
  // Doc Two has 0 blocks, so total = 4.
  assert.equal(blocks.totalBlocks, 4);
  assert.equal(blocks.blocks.length, 4);
  assert.equal(blocks.blocks[3]!.blockType, "heading");
  assert.match(blocks.blocks[3]!.text, /Attachment: doc-two\.pdf/);

  // Block 1 in the merged manifest spans charStart=9..charEnd=23 ("Paragraph one.").
  // A small char window centered there should return that paragraph as a slice.
  const expanded = expandDocument(
    {
      key: "ITEM1000",
      offset: 16,   // (9 + 23) / 2
      radius: 7,
    },
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
  );

  assert.match(expanded.passage, /Paragraph one\./);
  assert.equal(expanded.passageStart, 9);
  assert.equal(expanded.passageEnd, 23);
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
    itemKey: "ITEM5000",
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
        itemKey: "ITEM5000",
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

  // Block 1 spans charStart=14..charEnd=27 ("Second block.") in the rendered
  // markdown.  Center the slice on its midpoint and use a radius wide enough
  // to capture the block and a little context.
  const expanded = expandDocument(
    {
      key: "ITEM5000",
      offset: 20,   // floor((14 + 27) / 2)
      radius: 30,
    },
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
  );

  assert.equal(expanded.itemKey, "ITEM5000");
  assert.deepEqual(expanded.files, ["/tmp/doc-five.pdf"]);
  assert.match(expanded.passage, /Second block\./);
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
    itemKey: "ITEMA000",
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
        itemKey: "ITEMA000",
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
      key: "ITEMA000",
    },
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
  );

  assert.equal(fullText.itemKey, "ITEMA000");
  assert.ok(!("citationKey" in fullText), "citationKey must not be emitted");
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
    itemKey: "ITEMC000",
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
        itemKey: "ITEMC000",
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
      key: "ITEMC000",
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

test("fullTextDocument merges multiple attachments for one itemKey", () => {
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
    itemKey: "ITEMM000",
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
    itemKey: "ITEMM000",
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
        itemKey: "ITEMM000",
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
        itemKey: "ITEMM000",
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

  const merged = fullTextDocument(
    {
      key: "ITEMM000",
    },
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
  );

  assert.deepEqual(merged.files, ["/tmp/multi-one.pdf", "/tmp/multi-two.pdf"]);
  assert.ok(!("citationKey" in merged), "citationKey must not be emitted");
  assert.match(merged.content, /Unique paragraph one\./);
  assert.match(merged.content, /Unique paragraph two\./);
  assert.match(merged.content, /# Attachment: multi-two\.pdf/);

  // Same fixture, resolving by citationKey via the --key auto-dispatch.
  const mergedByCitationKey = fullTextDocument(
    { key: "lee2024multi" },
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
  );
  assert.equal(mergedByCitationKey.itemKey, "ITEMM000");
  assert.deepEqual(mergedByCitationKey.files, merged.files);
});

test("resolveReadyEntries rejects citationKey collisions across different itemKeys", () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-citationkey-collision-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docOne = "e".repeat(40);
  const docTwo = "f".repeat(40);
  const manifestOnePath = join(manifestsDir, `${docOne}${MANIFEST_EXT}`);
  const manifestTwoPath = join(manifestsDir, `${docTwo}${MANIFEST_EXT}`);

  writeManifest(manifestOnePath, {
    docKey: docOne,
    itemKey: "ITEMX000",
    citationKey: "dup2024",
    title: "Doc X",
    authors: ["A"],
    filePath: "/tmp/dup-x.pdf",
    normalizedPath: join(dataDir, "normalized", `${docOne}.md`),
    blocks: [],
  });
  writeManifest(manifestTwoPath, {
    docKey: docTwo,
    itemKey: "ITEMY000",
    citationKey: "dup2024",
    title: "Doc Y",
    authors: ["B"],
    filePath: "/tmp/dup-y.pdf",
    normalizedPath: join(dataDir, "normalized", `${docTwo}.md`),
    blocks: [],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [
      {
        docKey: docOne,
        itemKey: "ITEMX000",
        citationKey: "dup2024",
        title: "Doc X",
        authors: ["A"],
        filePath: "/tmp/dup-x.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-dup-x",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${docOne}.md`),
        manifestPath: manifestOnePath,
      },
      {
        docKey: docTwo,
        itemKey: "ITEMY000",
        citationKey: "dup2024",
        title: "Doc Y",
        authors: ["B"],
        filePath: "/tmp/dup-y.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-dup-y",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${docTwo}.md`),
        manifestPath: manifestTwoPath,
      },
    ],
  });

  assert.throws(
    () =>
      fullTextDocument(
        { key: "dup2024" },
        {
          bibliographyJsonPath: join(root, "bibliography.json"),
          attachmentsRoot: root,
          dataDir,
        },
      ),
    /Multiple items share citationKey "dup2024": itemKeys = ITEMX000, ITEMY000/,
  );
});

test("citationKey lookup resolves to itemKey first, then fetches every attachment for that item", () => {
  // Fixture: one item (ITEMP000) with two attachments; only the EPUB entry
  // carries citationKey, and the PDF sorts first. --key partial2024 should
  // still return both attachments (input-only alias; output is itemKey only).
  const root = mkdtempSync(join(tmpdir(), "zotagent-partial-citekey-"));
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });

  const docPdf = "p".repeat(40);
  const docEpub = "q".repeat(40);
  const manifestPdfPath = join(manifestsDir, `${docPdf}${MANIFEST_EXT}`);
  const manifestEpubPath = join(manifestsDir, `${docEpub}${MANIFEST_EXT}`);

  writeManifest(manifestPdfPath, {
    docKey: docPdf,
    itemKey: "ITEMP000",
    title: "Partial",
    authors: ["A"],
    filePath: "/tmp/partial-one.pdf",
    normalizedPath: join(dataDir, "normalized", `${docPdf}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "PDF body.",
        charStart: 0,
        charEnd: 9,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
    ],
  });
  writeManifest(manifestEpubPath, {
    docKey: docEpub,
    itemKey: "ITEMP000",
    citationKey: "partial2024",
    title: "Partial",
    authors: ["A"],
    filePath: "/tmp/partial-two.epub",
    normalizedPath: join(dataDir, "normalized", `${docEpub}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "EPUB body.",
        charStart: 0,
        charEnd: 10,
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
        docKey: docPdf,
        itemKey: "ITEMP000",
        title: "Partial",
        authors: ["A"],
        filePath: "/tmp/partial-one.pdf",
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-partial-pdf",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${docPdf}.md`),
        manifestPath: manifestPdfPath,
      },
      {
        docKey: docEpub,
        itemKey: "ITEMP000",
        citationKey: "partial2024",
        title: "Partial",
        authors: ["A"],
        filePath: "/tmp/partial-two.epub",
        fileExt: "epub",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash-partial-epub",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: join(dataDir, "normalized", `${docEpub}.md`),
        manifestPath: manifestEpubPath,
      },
    ],
  });

  const merged = fullTextDocument(
    { key: "partial2024" },
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot: root,
      dataDir,
    },
  );

  assert.equal(merged.itemKey, "ITEMP000");
  assert.ok(!("citationKey" in merged), "citationKey must not be emitted");
  assert.deepEqual(merged.files, ["/tmp/partial-one.pdf", "/tmp/partial-two.epub"]);
  assert.match(merged.content, /PDF body\./);
  assert.match(merged.content, /EPUB body\./);
});
