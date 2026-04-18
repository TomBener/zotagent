import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getDataPaths } from "../../src/config.js";
import { openKeywordIndex, segmentCjk, buildFtsQuery } from "../../src/keyword-db.js";
import type { AppConfig, CatalogEntry } from "../../src/types.js";
import { MANIFEST_EXT, writeManifestFile } from "../../src/utils.js";

function createConfig(dataDir: string): AppConfig {
  return {
    bibliographyJsonPath: "/tmp/bibliography.json",
    attachmentsRoot: "/tmp/attachments",
    dataDir,
    warnings: [],
  };
}

function readyEntry(
  dataDir: string,
  docKey: string,
  itemKey: string,
  title: string,
  filePath: string,
  manifestPath: string,
): CatalogEntry {
  return {
    docKey,
    itemKey,
    title,
    authors: ["A"],
    filePath,
    fileExt: "pdf",
    exists: true,
    supported: true,
    extractStatus: "ready",
    size: 1,
    mtimeMs: 1,
    sourceHash: `${docKey}-hash`,
    lastIndexedAt: new Date().toISOString(),
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    manifestPath,
  };
}

test("openKeywordIndex builds and searches with porter stemming", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-db-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "a".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);

  writeManifestFile(manifestPath, {
    docKey,
    itemKey: "ITEM1",
    title: "Party Secretary Governance in SOEs",
    authors: ["A"],
    filePath: "/tmp/test.pdf",
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "The company party secretary governs enterprise recruitment and promotion.",
        charStart: 0,
        charEnd: 72,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
    ],
  });

  const entry = readyEntry(dataDir, docKey, "ITEM1", "Party Secretary Governance in SOEs", "/tmp/test.pdf", manifestPath);
  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    await client.rebuildIndex([entry]);
    assert.equal(existsSync(getDataPaths(dataDir).keywordDbPath), true);

    // Porter stemming: "governing" matches "governs"
    const stemmed = await client.search("governing", 10);
    assert.equal(stemmed.length, 1);
    assert.equal(stemmed[0]!.docKey, docKey);

    // Multi-word AND
    const multi = await client.search("party secretary", 10);
    assert.equal(multi.length, 1);

    // Phrase search
    const phrase = await client.search('"party secretary"', 10);
    assert.equal(phrase.length, 1);

    // No match
    const missing = await client.search("nonexistent gibberish", 10);
    assert.deepEqual(missing, []);

    // OR operator
    const orQuery = await client.search("secretary OR gibberish", 10);
    assert.equal(orQuery.length, 1);

    // Prefix search
    const prefix = await client.search("govern*", 10);
    assert.equal(prefix.length, 1);
  } finally {
    await client.close();
  }
});

test("rebuildIndex replaces old entries with new ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-db-rebuild-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });

  const oldDocKey = "b".repeat(40);
  const newDocKey = "c".repeat(40);
  const oldManifestPath = join(manifestsDir, `${oldDocKey}${MANIFEST_EXT}`);
  const newManifestPath = join(manifestsDir, `${newDocKey}${MANIFEST_EXT}`);

  writeManifestFile(oldManifestPath, {
    docKey: oldDocKey, itemKey: "OLD1", title: "Old", authors: ["A"],
    filePath: "/tmp/old.pdf", normalizedPath: join(dataDir, "normalized", `${oldDocKey}.md`),
    blocks: [{ blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
      text: "cadres manage resources", charStart: 0, charEnd: 24, lineStart: 1, lineEnd: 1, isReferenceLike: false }],
  });
  writeManifestFile(newManifestPath, {
    docKey: newDocKey, itemKey: "NEW1", title: "New", authors: ["A"],
    filePath: "/tmp/new.pdf", normalizedPath: join(dataDir, "normalized", `${newDocKey}.md`),
    blocks: [{ blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
      text: "dangwei shuji appointed", charStart: 0, charEnd: 24, lineStart: 1, lineEnd: 1, isReferenceLike: false }],
  });

  const oldEntry = readyEntry(dataDir, oldDocKey, "OLD1", "Old", "/tmp/old.pdf", oldManifestPath);
  const newEntry = readyEntry(dataDir, newDocKey, "NEW1", "New", "/tmp/new.pdf", newManifestPath);

  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    await client.rebuildIndex([oldEntry]);
    assert.equal((await client.search("cadres", 10)).length, 1);

    // Full rebuild with only the new entry — old entry should be gone.
    await client.rebuildIndex([newEntry]);
    assert.deepEqual(await client.search("cadres", 10), []);
    assert.equal((await client.search("dangwei", 10)).length, 1);
  } finally {
    await client.close();
  }
});

test("search throws on empty query", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-db-empty-"));
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "index"), { recursive: true });

  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    await assert.rejects(
      () => client.search("", 10),
      { message: "Search text cannot be empty." },
    );
  } finally {
    await client.close();
  }
});

test("segmentCjk inserts spaces between CJK characters", () => {
  assert.equal(segmentCjk("盛世才在新疆"), "盛 世 才 在 新 疆");
  assert.equal(segmentCjk("hello world"), "hello world");
  assert.equal(segmentCjk("新疆is边疆"), "新 疆 is 边 疆");
  assert.equal(segmentCjk("is边疆"), "is 边 疆");
  assert.equal(segmentCjk("新疆is"), "新 疆 is");
  assert.equal(segmentCjk(""), "");
  assert.equal(segmentCjk("abc"), "abc");
});

test("buildFtsQuery converts CJK runs to NEAR queries", () => {
  assert.equal(buildFtsQuery("盛世才"), "NEAR(盛 世 才, 2)");
  assert.equal(buildFtsQuery("韜奮 抗戰"), "NEAR(韜 奮, 1) NEAR(抗 戰, 1)");
  assert.equal(buildFtsQuery("hello"), "hello");
  assert.equal(buildFtsQuery("新 疆"), "新 疆");
  assert.equal(buildFtsQuery("独山子油矿"), "NEAR(独 山 子 油 矿, 4)");
  assert.equal(buildFtsQuery("is边疆"), "is NEAR(边 疆, 1)");
  assert.equal(buildFtsQuery('"盛世才"'), '"盛 世 才"');
  assert.equal(buildFtsQuery('hello "盛世才" world'), 'hello "盛 世 才" world');
});

test("CJK keyword search matches Chinese content via NEAR", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-cjk-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "e".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  writeManifestFile(manifestPath, {
    docKey, itemKey: "CJK1", title: "盛世才與新新疆", authors: ["杜重遠"],
    filePath: "/tmp/cjk.pdf", normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    blocks: [{ blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
      text: "盛世才是新疆近代史上的重要人物", charStart: 0, charEnd: 30, lineStart: 1, lineEnd: 1, isReferenceLike: false }],
  });

  const entry = readyEntry(dataDir, docKey, "CJK1", "盛世才與新新疆", "/tmp/cjk.pdf", manifestPath);
  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    await client.rebuildIndex([entry]);
    const results = await client.search("盛世才", 10);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.docKey, docKey);

    const results2 = await client.search("新疆", 10);
    assert.equal(results2.length, 1);

    const quoted = await client.search('"盛世才"', 10);
    assert.equal(quoted.length, 1);
    assert.equal(quoted[0]!.docKey, docKey);
  } finally {
    await client.close();
  }
});

test("search handles malformed FTS5 queries gracefully", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-db-malformed-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "d".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  writeManifestFile(manifestPath, {
    docKey, itemKey: "ITEM1", title: "Test", authors: ["A"],
    filePath: "/tmp/test.pdf", normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    blocks: [{ blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
      text: "aging in China is a topic", charStart: 0, charEnd: 26, lineStart: 1, lineEnd: 1, isReferenceLike: false }],
  });

  const entry = readyEntry(dataDir, docKey, "ITEM1", "Test", "/tmp/test.pdf", manifestPath);
  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    await client.rebuildIndex([entry]);
    // Unbalanced quotes should not throw, should fall back to sanitized query
    const results = await client.search('"aging in', 10);
    assert.equal(results.length, 1);
  } finally {
    await client.close();
  }
});
