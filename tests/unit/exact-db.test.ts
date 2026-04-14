import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { getDataPaths } from "../../src/config.js";
import { openExactIndex } from "../../src/exact-db.js";
import type { AppConfig, AttachmentManifest, CatalogEntry } from "../../src/types.js";

function createConfig(dataDir: string): AppConfig {
  return {
    bibliographyJsonPath: "/tmp/bibliography.json",
    attachmentsRoot: "/tmp/attachments",
    dataDir,
    warnings: [],
  };
}

function writeManifest(path: string, manifest: AttachmentManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2), "utf-8");
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

test("openExactIndex rebuilds and searches Chinese and English lexical candidates", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-exact-db-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });

  const leeDocKey = "a".repeat(40);
  const chanDocKey = "b".repeat(40);
  const leeManifestPath = join(manifestsDir, `${leeDocKey}.json`);
  const chanManifestPath = join(manifestsDir, `${chanDocKey}.json`);

  writeManifest(leeManifestPath, {
    docKey: leeDocKey,
    itemKey: "LEE1",
    title: "From cadres to managers",
    authors: ["Lee"],
    filePath: "/tmp/lee.pdf",
    normalizedPath: join(dataDir, "normalized", `${leeDocKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "The DHA programme promotes market selection and recruitment (shichanghua xuanpin 市場化選聘).",
        charStart: 0,
        charEnd: 97,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
    ],
  });
  writeManifest(chanManifestPath, {
    docKey: chanDocKey,
    itemKey: "CHAN1",
    title: "Inside China's state-owned enterprises",
    authors: ["Chan"],
    filePath: "/tmp/chan.pdf",
    normalizedPath: join(dataDir, "normalized", `${chanDocKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "The top leader is the company party secretary (dangwei shuji).",
        charStart: 0,
        charEnd: 65,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
    ],
  });

  const client = await openExactIndex(createConfig(dataDir));
  try {
    await client.rebuildExactIndex([
      readyEntry(dataDir, leeDocKey, "LEE1", "From cadres to managers", "/tmp/lee.pdf", leeManifestPath),
      readyEntry(
        dataDir,
        chanDocKey,
        "CHAN1",
        "Inside China's state-owned enterprises",
        "/tmp/chan.pdf",
        chanManifestPath,
      ),
    ]);

    assert.equal(existsSync(getDataPaths(dataDir).exactDbPath), true);

    const chineseSubstring = await client.searchExactCandidates("選聘", 10);
    assert.deepEqual(chineseSubstring.map((candidate) => candidate.docKey), [leeDocKey]);

    const chinesePhrase = await client.searchExactCandidates("市場化選聘", 10);
    assert.deepEqual(chinesePhrase.map((candidate) => candidate.docKey), [leeDocKey]);

    const englishPhrase = await client.searchExactCandidates("dangwei shuji", 10);
    assert.deepEqual(englishPhrase.map((candidate) => candidate.docKey), [chanDocKey]);

    const missing = await client.searchExactCandidates("nonexistent phrase", 10);
    assert.deepEqual(missing, []);
  } finally {
    await client.close();
  }
});

test("rebuildExactIndex replaces stale documents on full rebuild", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-exact-db-stale-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });

  const oldDocKey = "c".repeat(40);
  const newDocKey = "d".repeat(40);
  const oldManifestPath = join(manifestsDir, `${oldDocKey}.json`);
  const newManifestPath = join(manifestsDir, `${newDocKey}.json`);

  writeManifest(oldManifestPath, {
    docKey: oldDocKey,
    itemKey: "OLD1",
    title: "Old",
    authors: ["Old"],
    filePath: "/tmp/old.pdf",
    normalizedPath: join(dataDir, "normalized", `${oldDocKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "市場化選聘 appears in this old document.",
        charStart: 0,
        charEnd: 34,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
    ],
  });
  writeManifest(newManifestPath, {
    docKey: newDocKey,
    itemKey: "NEW1",
    title: "New",
    authors: ["New"],
    filePath: "/tmp/new.pdf",
    normalizedPath: join(dataDir, "normalized", `${newDocKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "dangwei shuji appears in this new document.",
        charStart: 0,
        charEnd: 43,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
    ],
  });

  const client = await openExactIndex(createConfig(dataDir));
  try {
    await client.rebuildExactIndex([
      readyEntry(dataDir, oldDocKey, "OLD1", "Old", "/tmp/old.pdf", oldManifestPath),
    ]);
    assert.deepEqual(
      (await client.searchExactCandidates("選聘", 10)).map((candidate) => candidate.docKey),
      [oldDocKey],
    );

    await client.rebuildExactIndex([
      readyEntry(dataDir, newDocKey, "NEW1", "New", "/tmp/new.pdf", newManifestPath),
    ]);
    assert.deepEqual(await client.searchExactCandidates("選聘", 10), []);
    assert.deepEqual(
      (await client.searchExactCandidates("dangwei shuji", 10)).map((candidate) => candidate.docKey),
      [newDocKey],
    );
  } finally {
    await client.close();
  }
});

test("syncExactIndex upserts changed documents and deletes stale ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-exact-db-incremental-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });

  const oldDocKey = "e".repeat(40);
  const keptDocKey = "f".repeat(40);
  const newDocKey = "g".repeat(40);
  const oldManifestPath = join(manifestsDir, `${oldDocKey}.json`);
  const keptManifestPath = join(manifestsDir, `${keptDocKey}.json`);
  const newManifestPath = join(manifestsDir, `${newDocKey}.json`);

  writeManifest(oldManifestPath, {
    docKey: oldDocKey,
    itemKey: "OLD1",
    title: "Old",
    authors: ["Old"],
    filePath: "/tmp/old.pdf",
    normalizedPath: join(dataDir, "normalized", `${oldDocKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "This old document mentions cadres only.",
        charStart: 0,
        charEnd: 39,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
    ],
  });
  writeManifest(keptManifestPath, {
    docKey: keptDocKey,
    itemKey: "KEEP1",
    title: "Kept",
    authors: ["Keep"],
    filePath: "/tmp/kept.pdf",
    normalizedPath: join(dataDir, "normalized", `${keptDocKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "The company party secretary is the dangwei shuji.",
        charStart: 0,
        charEnd: 50,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
    ],
  });
  writeManifest(newManifestPath, {
    docKey: newDocKey,
    itemKey: "NEW1",
    title: "New",
    authors: ["New"],
    filePath: "/tmp/new.pdf",
    normalizedPath: join(dataDir, "normalized", `${newDocKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "Xie Shuqing visited the work team.",
        charStart: 0,
        charEnd: 35,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
    ],
  });

  const client = await openExactIndex(createConfig(dataDir));
  try {
    await client.rebuildExactIndex([
      readyEntry(dataDir, oldDocKey, "OLD1", "Old", "/tmp/old.pdf", oldManifestPath),
      readyEntry(dataDir, keptDocKey, "KEEP1", "Kept", "/tmp/kept.pdf", keptManifestPath),
    ]);

    await client.syncExactIndex?.(
      [
        readyEntry(dataDir, keptDocKey, "KEEP1", "Kept", "/tmp/kept.pdf", keptManifestPath),
        readyEntry(dataDir, newDocKey, "NEW1", "New", "/tmp/new.pdf", newManifestPath),
      ],
      {
        upserts: [readyEntry(dataDir, newDocKey, "NEW1", "New", "/tmp/new.pdf", newManifestPath)],
        deleteDocKeys: [oldDocKey],
      },
    );

    assert.deepEqual(await client.searchExactCandidates("cadres", 10), []);
    assert.deepEqual(
      (await client.searchExactCandidates("dangwei shuji", 10)).map((candidate) => candidate.docKey),
      [keptDocKey],
    );
    assert.deepEqual(
      (await client.searchExactCandidates("xie shuqing", 10)).map((candidate) => candidate.docKey),
      [newDocKey],
    );
  } finally {
    await client.close();
  }
});

test("syncExactIndex rebuilds from ready entries when the exact db starts empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-exact-db-missing-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "h".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}.json`);
  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEM1",
    title: "Missing index",
    authors: ["A"],
    filePath: "/tmp/missing.pdf",
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "The company party secretary is the dangwei shuji.",
        charStart: 0,
        charEnd: 50,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
    ],
  });

  const client = await openExactIndex(createConfig(dataDir));
  try {
    await client.syncExactIndex?.(
      [readyEntry(dataDir, docKey, "ITEM1", "Missing index", "/tmp/missing.pdf", manifestPath)],
      {
        upserts: [],
        deleteDocKeys: [],
      },
    );

    assert.deepEqual(
      (await client.searchExactCandidates("dangwei shuji", 10)).map((candidate) => candidate.docKey),
      [docKey],
    );
  } finally {
    await client.close();
  }
});
