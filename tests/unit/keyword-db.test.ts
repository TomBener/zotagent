import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { segmentCjk } from "../../src/cjk.js";
import { getDataPaths } from "../../src/config.js";
import {
  KeywordQuerySyntaxError,
  keywordIndexIsCurrent,
  openKeywordIndex,
  buildFtsQuery,
  rewriteInfixNear,
} from "../../src/keyword-db.js";
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
  docKey: string,
  itemKey: string,
  title: string,
  filePath: string,
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

  const entry = readyEntry(docKey, "ITEM1", "Party Secretary Governance in SOEs", "/tmp/test.pdf");
  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    await client.rebuildIndex([entry]);
    assert.equal(existsSync(getDataPaths(dataDir).keywordDbPath), true);

    // Porter stemming: "governing" matches "governs"
    const stemmed = await client.searchDocs("governing", 10);
    assert.equal(stemmed.length, 1);
    assert.equal(stemmed[0]!.docKey, docKey);

    // Multi-word AND
    const multi = await client.searchDocs("party secretary", 10);
    assert.equal(multi.length, 1);

    // Phrase search
    const phrase = await client.searchDocs('"party secretary"', 10);
    assert.equal(phrase.length, 1);

    // No match
    const missing = await client.searchDocs("nonexistent gibberish", 10);
    assert.deepEqual(missing, []);

    // OR operator
    const orQuery = await client.searchDocs("secretary OR gibberish", 10);
    assert.equal(orQuery.length, 1);

    // Prefix search
    const prefix = await client.searchDocs("govern*", 10);
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
    filePath: "/tmp/old.pdf",
    blocks: [{ blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
      text: "cadres manage resources", charStart: 0, charEnd: 24, lineStart: 1, lineEnd: 1, isReferenceLike: false }],
  });
  writeManifestFile(newManifestPath, {
    docKey: newDocKey, itemKey: "NEW1", title: "New", authors: ["A"],
    filePath: "/tmp/new.pdf",
    blocks: [{ blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
      text: "dangwei shuji appointed", charStart: 0, charEnd: 24, lineStart: 1, lineEnd: 1, isReferenceLike: false }],
  });

  const oldEntry = readyEntry(oldDocKey, "OLD1", "Old", "/tmp/old.pdf");
  const newEntry = readyEntry(newDocKey, "NEW1", "New", "/tmp/new.pdf");

  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    await client.rebuildIndex([oldEntry]);
    assert.equal((await client.searchDocs("cadres", 10)).length, 1);

    // Full rebuild with only the new entry — old entry should be gone.
    await client.rebuildIndex([newEntry]);
    assert.deepEqual(await client.searchDocs("cadres", 10), []);
    assert.equal((await client.searchDocs("dangwei", 10)).length, 1);
  } finally {
    await client.close();
  }
});

test("updateIndex upserts changed entries and removes deleted docKeys", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-db-incremental-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });

  const removedDocKey = "d".repeat(40);
  const changedDocKey = "e".repeat(40);
  const unchangedDocKey = "f".repeat(40);
  const addedDocKey = "1".repeat(40);

  const writeOneBlockManifest = (docKey: string, itemKey: string, text: string) => {
    const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
    writeManifestFile(manifestPath, {
      docKey,
      itemKey,
      title: itemKey,
      authors: ["A"],
      filePath: `/tmp/${docKey}.pdf`,
      blocks: [{ blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
        text, charStart: 0, charEnd: text.length, lineStart: 1, lineEnd: 1, isReferenceLike: false }],
    });
  };

  writeOneBlockManifest(removedDocKey, "REMOVED", "old removed token");
  writeOneBlockManifest(changedDocKey, "CHANGED", "old changed token");
  writeOneBlockManifest(unchangedDocKey, "UNCHANGED", "stable retained token");
  const removedEntry = readyEntry(removedDocKey, "REMOVED", "Removed", "/tmp/removed.pdf");
  const changedEntry = readyEntry(changedDocKey, "CHANGED", "Changed", "/tmp/changed.pdf");
  const unchangedEntry = readyEntry(unchangedDocKey, "UNCHANGED", "Unchanged", "/tmp/unchanged.pdf");

  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    await client.rebuildIndex([removedEntry, changedEntry, unchangedEntry]);
    assert.equal((await client.searchDocs("removed", 10)).length, 1);
    assert.equal((await client.searchDocs("changed", 10)).length, 1);
    assert.equal((await client.searchDocs("retained", 10)).length, 1);

    writeOneBlockManifest(changedDocKey, "CHANGED", "fresh changed token");
    writeOneBlockManifest(addedDocKey, "ADDED", "newly added token");
    const changedFreshEntry = readyEntry(changedDocKey, "CHANGED", "Changed", "/tmp/changed.pdf");
    const addedEntry = readyEntry(addedDocKey, "ADDED", "Added", "/tmp/added.pdf");

    await client.updateIndex([changedFreshEntry, addedEntry], [removedDocKey]);

    assert.deepEqual(await client.searchDocs("removed", 10), []);
    assert.deepEqual(await client.searchDocs('"old changed"', 10), []);
    assert.equal((await client.searchDocs('"fresh changed"', 10)).length, 1);
    assert.equal((await client.searchDocs('"newly added"', 10)).length, 1);
    assert.equal((await client.searchDocs('"stable retained"', 10)).length, 1);
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
      () => client.searchDocs("", 10),
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

test("buildFtsQuery converts CJK runs to ordered phrases", () => {
  assert.equal(buildFtsQuery("盛世才"), '"盛 世 才"');
  // Traditional input is folded to simplified before phrase assembly.
  assert.equal(buildFtsQuery("韜奮 抗戰"), '"韬 奋" "抗 战"');
  assert.equal(buildFtsQuery("hello"), "hello");
  assert.equal(buildFtsQuery("新 疆"), "新 疆");
  assert.equal(buildFtsQuery("独山子油矿"), '"独 山 子 油 矿"');
  // A word glued to CJK is one phrase, the adjacency the index holds.
  assert.equal(buildFtsQuery("is边疆"), '"is 边 疆"');
  assert.equal(buildFtsQuery("1949年"), '"1949 年"');
  assert.equal(buildFtsQuery("盛世*"), '"盛 世"*');
  assert.equal(buildFtsQuery('"盛世才"'), '"盛 世 才"');
  assert.equal(buildFtsQuery('hello "盛世才" world'), 'hello "盛 世 才" world');
});

test("buildFtsQuery folds traditional Chinese to simplified", () => {
  // Unquoted traditional run becomes a simplified phrase.
  assert.equal(buildFtsQuery("繁體"), '"繁 体"');
  // Quoted traditional phrase is converted character-by-character.
  assert.equal(buildFtsQuery('"繁體中文"'), '"繁 体 中 文"');
  // Mixed traditional + simplified in one query collapses to simplified.
  assert.equal(buildFtsQuery("韜奋"), '"韬 奋"');
  // NEAR/N infix with traditional CJK phrases still produces simplified phrases.
  assert.match(
    buildFtsQuery('"開發新疆" NEAR/5 "人力財力"'),
    /^NEAR\(\s*"开 发 新 疆"\s+"人 力 财 力"\s*,\s*5\s*\)$/u,
  );
});

test("buildFtsQuery applies NFKC before folding", () => {
  // Ligatures and full-width forms reach the index as their plain letters.
  assert.equal(buildFtsQuery("exempli\uFB01es"), "exemplifies");
  assert.equal(buildFtsQuery("\uFF11\uFF19\uFF14\uFF19年以后"), '"1949 年 以 后"');
  // Full-width punctuation separates words as it does in the index; it never
  // turns into FTS5 syntax (quotes, commas, parentheses, colons).
  assert.equal(buildFtsQuery("\uFF02institutional change\uFF02"), "institutional change");
  assert.equal(buildFtsQuery("国家\uFF0C能力"), '"国 家" "能 力"');
  assert.equal(buildFtsQuery("\uFF08国家\uFF09\uFF1A能力"), '"国 家" "能 力"');
});

test("rewriteInfixNear rewrites infix NEAR to function form", () => {
  assert.equal(rewriteInfixNear('"A" NEAR/5 "B"'), 'NEAR("A" "B", 5)');
  assert.equal(rewriteInfixNear("A NEAR/10 B"), "NEAR(A B, 10)");
  // CJK bareword infix must be auto-quoted to prevent nested NEAR expansion downstream.
  assert.equal(rewriteInfixNear("开发新疆 NEAR/50 人力财力"), 'NEAR("开发新疆" "人力财力", 50)');
  // Leave non-NEAR text alone.
  assert.equal(rewriteInfixNear("hello world"), "hello world");
});

test("rewriteInfixNear preserves NEAR that appears inside a quoted literal phrase", () => {
  // Regression: a literal phrase search that happens to contain the word "near"
  // must not be rewritten into a NEAR() call, or it will stop matching documents
  // whose text literally says "foo near bar".
  assert.equal(rewriteInfixNear('"foo NEAR bar"'), '"foo NEAR bar"');
  assert.equal(rewriteInfixNear('"close NEAR/5 neighbor"'), '"close NEAR/5 neighbor"');
  // Real infix outside quotes should still be rewritten when mixed with a quoted literal.
  assert.equal(
    rewriteInfixNear('"foo NEAR bar" AND "open up" NEAR/5 closed'),
    '"foo NEAR bar" AND NEAR("open up" closed, 5)',
  );
});

test("buildFtsQuery preserves NEAR as a literal token inside a quoted phrase", () => {
  // The final FTS5 query should still contain "foo near bar" as a single phrase,
  // not NEAR(foo bar).
  const out = buildFtsQuery('"foo NEAR bar"');
  assert.match(out, /^"foo NEAR bar"$/u);
  assert.doesNotMatch(out, /NEAR\(/u);
});

test("buildFtsQuery rejects FTS5 NEAR function syntax as user input", () => {
  assert.throws(
    () => buildFtsQuery('NEAR("A" "B", 5)'),
    KeywordQuerySyntaxError,
  );
  assert.throws(
    () => buildFtsQuery('NEAR("开发新疆" "人力财力", 50)'),
    /Use the single proximity form/u,
  );
  assert.equal(buildFtsQuery('"NEAR(foo bar)"'), '"NEAR(foo bar)"');
});

test("buildFtsQuery rejects bare infix NEAR without an explicit distance", () => {
  assert.throws(
    () => buildFtsQuery("A NEAR B"),
    /Bare NEAR is not supported/u,
  );
  assert.throws(
    () => buildFtsQuery('"开发新疆" NEAR "人力财力"'),
    KeywordQuerySyntaxError,
  );
});

test("buildFtsQuery produces FTS5-compatible output for canonical NEAR/N with CJK phrases", () => {
  // Bug: CJK proximity was previously passed through in a form that FTS5 tokenized
  // `NEAR` as a bareword → zero hits on Chinese corpora. Fix rewrites to function form.
  assert.match(
    buildFtsQuery("开发新疆 NEAR/50 人力财力"),
    /^NEAR\(\s*"开 发 新 疆"\s+"人 力 财 力"\s*,\s*50\s*\)$/u,
  );
  assert.match(
    buildFtsQuery('"开发新疆" NEAR/5 "人力财力"'),
    /^NEAR\(\s*"开 发 新 疆"\s+"人 力 财 力"\s*,\s*5\s*\)$/u,
  );
});

test("CJK keyword search matches Chinese content via ordered phrases", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-cjk-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "e".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  writeManifestFile(manifestPath, {
    docKey, itemKey: "CJK1", title: "盛世才與新新疆", authors: ["杜重遠"],
    filePath: "/tmp/cjk.pdf",
    blocks: [{ blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
      text: "盛世才是新疆近代史上的重要人物", charStart: 0, charEnd: 30, lineStart: 1, lineEnd: 1, isReferenceLike: false }],
  });

  const entry = readyEntry(docKey, "CJK1", "盛世才與新新疆", "/tmp/cjk.pdf");
  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    await client.rebuildIndex([entry]);
    const results = await client.searchDocs("盛世才", 10);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.docKey, docKey);

    const results2 = await client.searchDocs("新疆", 10);
    assert.equal(results2.length, 1);

    const quoted = await client.searchDocs('"盛世才"', 10);
    assert.equal(quoted.length, 1);
    assert.equal(quoted[0]!.docKey, docKey);
  } finally {
    await client.close();
  }
});

test("CJK keyword search respects character order and NFKC-folds both sides", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-order-nfkc-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });

  const block = (text: string) => ({
    blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
    text, charStart: 0, charEnd: text.length, lineStart: 1, lineEnd: 1, isReferenceLike: false,
  });
  const docs = [
    { docKey: "1".repeat(40), itemKey: "SHEHUI01", text: "社会结构与\n国家能力" },
    { docKey: "2".repeat(40), itemKey: "LIGATURE", text: "This case exempliﬁes the ﬂow of １９４９年以后 reforms." },
  ];
  for (const doc of docs) {
    writeManifestFile(join(manifestsDir, `${doc.docKey}${MANIFEST_EXT}`), {
      docKey: doc.docKey, itemKey: doc.itemKey, title: doc.itemKey, authors: ["A"],
      filePath: `/tmp/${doc.itemKey}.pdf`, blocks: [block(doc.text)],
    });
  }

  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    await client.rebuildIndex(docs.map((doc) => readyEntry(doc.docKey, doc.itemKey, doc.itemKey, `/tmp/${doc.itemKey}.pdf`)));
    const hit = async (query: string) => (await client.searchDocs(query, 10)).map((row) => row.docKey);

    // Reversed characters are a different word, not a looser match.
    assert.deepEqual(await hit("社会"), [docs[0]!.docKey]);
    assert.deepEqual(await hit("会社"), []);
    // A line break inside a word is not a token, so the phrase still matches.
    assert.deepEqual(await hit("与国家"), [docs[0]!.docKey]);

    // Plain queries find ligature and full-width source text, and vice versa.
    assert.deepEqual(await hit("exemplifies"), [docs[1]!.docKey]);
    assert.deepEqual(await hit("flow"), [docs[1]!.docKey]);
    assert.deepEqual(await hit("1949年以后"), [docs[1]!.docKey]);
    assert.deepEqual(await hit("1949年"), [docs[1]!.docKey]);
    assert.deepEqual(await hit("社会\uFF0C国家"), [docs[0]!.docKey]);
    assert.deepEqual(await hit("exempliﬁes"), [docs[1]!.docKey]);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("keywordIndexIsCurrent reports an index not rebuilt by this indexer version", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-current-"));
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "manifests"), { recursive: true });
  // No index yet: nothing stale to warn about.
  assert.equal(keywordIndexIsCurrent(dataDir), true);

  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    // Opened (schema created) but never rebuilt by this version — the state
    // an index built by an older zotagent is in after an upgrade.
    assert.equal(keywordIndexIsCurrent(dataDir), false);
    await client.updateIndex([], []);
    assert.equal(keywordIndexIsCurrent(dataDir), false, "an incremental update does not refold rows");
    await client.rebuildIndex([]);
    assert.equal(keywordIndexIsCurrent(dataDir), true);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("keyword search is agnostic to traditional vs simplified Chinese", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-trad-simp-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });

  // Doc A: stored in traditional Chinese.
  const tradKey = "f".repeat(40);
  const tradManifest = join(manifestsDir, `${tradKey}${MANIFEST_EXT}`);
  writeManifestFile(tradManifest, {
    docKey: tradKey, itemKey: "TRAD1", title: "開發新疆研究", authors: ["A"],
    filePath: "/tmp/trad.pdf",
    blocks: [{ blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
      text: "本文討論開發新疆的人力財力問題。", charStart: 0, charEnd: 20, lineStart: 1, lineEnd: 1, isReferenceLike: false }],
  });

  // Doc B: stored in simplified Chinese.
  const simpKey = "1".repeat(40);
  const simpManifest = join(manifestsDir, `${simpKey}${MANIFEST_EXT}`);
  writeManifestFile(simpManifest, {
    docKey: simpKey, itemKey: "SIMP1", title: "开发新疆研究", authors: ["A"],
    filePath: "/tmp/simp.pdf",
    blocks: [{ blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
      text: "本文讨论开发新疆的人力财力问题。", charStart: 0, charEnd: 20, lineStart: 1, lineEnd: 1, isReferenceLike: false }],
  });

  const tradEntry = readyEntry(tradKey, "TRAD1", "開發新疆研究", "/tmp/trad.pdf");
  const simpEntry = readyEntry(simpKey, "SIMP1", "开发新疆研究", "/tmp/simp.pdf");

  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    await client.rebuildIndex([tradEntry, simpEntry]);

    // A simplified query finds both documents.
    const simpHits = await client.searchDocs("开发新疆", 10);
    assert.equal(simpHits.length, 2);
    assert.deepEqual(
      simpHits.map((h) => h.docKey).sort(),
      [tradKey, simpKey].sort(),
    );

    // A traditional query finds both documents.
    const tradHits = await client.searchDocs("開發新疆", 10);
    assert.equal(tradHits.length, 2);
    assert.deepEqual(
      tradHits.map((h) => h.docKey).sort(),
      [tradKey, simpKey].sort(),
    );

    // Quoted phrase form works across variants.
    const quotedTrad = await client.searchDocs('"開發新疆"', 10);
    assert.equal(quotedTrad.length, 2);
    const quotedSimp = await client.searchDocs('"开发新疆"', 10);
    assert.equal(quotedSimp.length, 2);

    // NEAR/N proximity across variants.
    const nearHits = await client.searchDocs('"開發新疆" NEAR/20 "人力財力"', 10);
    assert.equal(nearHits.length, 2);
  } finally {
    await client.close();
  }
});

test("keyword search accepts canonical NEAR/N with CJK phrases against a real FTS5 index", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-cjk-near-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "7".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  writeManifestFile(manifestPath, {
    docKey, itemKey: "NEAR1", title: "盛世才與新新疆", authors: ["A"],
    filePath: "/tmp/near.pdf",
    blocks: [
      { blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
        text: "欢迎英美人力财力开发新疆;请中央交涉。",
        charStart: 0, charEnd: 18, lineStart: 1, lineEnd: 1, isReferenceLike: false },
    ],
  });

  const entry = readyEntry(docKey, "NEAR1", "盛世才與新新疆", "/tmp/near.pdf");
  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    await client.rebuildIndex([entry]);
    const distance = await client.searchDocs('"开发新疆" NEAR/50 "人力财力"', 10);
    assert.equal(distance.length, 1);
    assert.equal(distance[0]!.docKey, docKey);
    await assert.rejects(
      () => client.searchDocs('"开发新疆" NEAR "人力财力"', 10),
      KeywordQuerySyntaxError,
    );
    await assert.rejects(
      () => client.searchDocs('NEAR("开发新疆" "人力财力", 50)', 10),
      KeywordQuerySyntaxError,
    );
  } finally {
    await client.close();
  }
});

test("quoted literal containing the word NEAR still matches the original text", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-quoted-near-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "9".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  writeManifestFile(manifestPath, {
    docKey, itemKey: "NEARLIT", title: "Near Study", authors: ["A"],
    filePath: "/tmp/near-literal.pdf",
    blocks: [
      { blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
        text: "the store is located foo near bar on main street",
        charStart: 0, charEnd: 48, lineStart: 1, lineEnd: 1, isReferenceLike: false },
    ],
  });

  const entry = readyEntry(docKey, "NEARLIT", "Near Study", "/tmp/near-literal.pdf");
  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    await client.rebuildIndex([entry]);
    const results = await client.searchDocs('"foo NEAR bar"', 10);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.docKey, docKey);
  } finally {
    await client.close();
  }
});

test("isEmpty reports true for a fresh index and false once populated", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-empty-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "8".repeat(40);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  writeManifestFile(manifestPath, {
    docKey, itemKey: "EMPTY1", title: "Empty Check", authors: ["A"],
    filePath: "/tmp/empty.pdf",
    blocks: [{ blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
      text: "something", charStart: 0, charEnd: 9, lineStart: 1, lineEnd: 1, isReferenceLike: false }],
  });

  const entry = readyEntry(docKey, "EMPTY1", "Empty Check", "/tmp/empty.pdf");
  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    assert.equal(await client.isEmpty(), true);
    await client.rebuildIndex([entry]);
    assert.equal(await client.isEmpty(), false);
  } finally {
    await client.close();
  }
});

test("search filters to a single docKey when docKeys is provided", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-db-dockeys-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });

  const docOne = "1".repeat(40);
  const docTwo = "2".repeat(40);
  const manifestOne = join(manifestsDir, `${docOne}${MANIFEST_EXT}`);
  const manifestTwo = join(manifestsDir, `${docTwo}${MANIFEST_EXT}`);

  writeManifestFile(manifestOne, {
    docKey: docOne, itemKey: "ITEM1", title: "Doc One", authors: ["A"],
    filePath: "/tmp/one.pdf",
    blocks: [{ blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
      text: "Property rights and rural land tenure.", charStart: 0, charEnd: 38, lineStart: 1, lineEnd: 1, isReferenceLike: false }],
  });
  writeManifestFile(manifestTwo, {
    docKey: docTwo, itemKey: "ITEM2", title: "Doc Two", authors: ["B"],
    filePath: "/tmp/two.pdf",
    blocks: [{ blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
      text: "Property rights also feature here.", charStart: 0, charEnd: 33, lineStart: 1, lineEnd: 1, isReferenceLike: false }],
  });

  const entries = [
    readyEntry(docOne, "ITEM1", "Doc One", "/tmp/one.pdf"),
    readyEntry(docTwo, "ITEM2", "Doc Two", "/tmp/two.pdf"),
  ];
  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    await client.rebuildIndex(entries);

    const all = await client.searchDocs("property", 10);
    assert.equal(all.length, 2);

    const filtered = await client.searchDocs("property", 10, { docKeys: [docTwo] });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]!.docKey, docTwo);

    const empty = await client.searchDocs("property", 10, { docKeys: [] });
    assert.equal(empty.length, 2, "an empty docKeys array should not constrain results");
  } finally {
    await client.close();
  }
});

test("searchBlocks returns block-level hits filtered by docKeys", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-db-blocks-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });

  const docOne = "8".repeat(40);
  const docTwo = "9".repeat(40);
  const manifestOne = join(manifestsDir, `${docOne}${MANIFEST_EXT}`);
  const manifestTwo = join(manifestsDir, `${docTwo}${MANIFEST_EXT}`);

  writeManifestFile(manifestOne, {
    docKey: docOne, itemKey: "ITEMA", title: "Doc A", authors: ["A"],
    filePath: "/tmp/a.pdf",
    blocks: [
      { blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
        text: "Property rights and rural land tenure are central themes.",
        charStart: 0, charEnd: 60, lineStart: 1, lineEnd: 1, isReferenceLike: false },
      { blockIndex: 1, blockType: "paragraph", sectionPath: ["Body"],
        text: "An unrelated paragraph about something else entirely.",
        charStart: 62, charEnd: 115, lineStart: 3, lineEnd: 3, isReferenceLike: false },
    ],
  });
  writeManifestFile(manifestTwo, {
    docKey: docTwo, itemKey: "ITEMB", title: "Doc B", authors: ["B"],
    filePath: "/tmp/b.pdf",
    blocks: [
      { blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
        text: "Property rights regimes vary across jurisdictions.",
        charStart: 0, charEnd: 50, lineStart: 1, lineEnd: 1, isReferenceLike: false },
    ],
  });

  const entries = [
    readyEntry(docOne, "ITEMA", "Doc A", "/tmp/a.pdf"),
    readyEntry(docTwo, "ITEMB", "Doc B", "/tmp/b.pdf"),
  ];
  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    await client.rebuildIndex(entries);

    // No docKeys filter: hits across both docs.
    const all = await client.searchBlocks("property", 10);
    assert.equal(all.length, 2);
    const allKeys = new Set(all.map((r) => r.docKey));
    assert.ok(allKeys.has(docOne) && allKeys.has(docTwo));

    // Filtered to docOne: only the matching block in that doc.
    const filtered = await client.searchBlocks("property", 10, { docKeys: [docOne] });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]!.docKey, docOne);
    assert.equal(filtered[0]!.blockIndex, 0);

    // Phrase query within one block.
    const phrase = await client.searchBlocks('"rural land"', 10, { docKeys: [docOne] });
    assert.equal(phrase.length, 1);
    assert.equal(phrase[0]!.blockIndex, 0);

    // Phrase that does not appear in any block: no hit (phrase queries do not
    // cross block rows).
    const noMatch = await client.searchBlocks('"unrelated property"', 10, { docKeys: [docOne] });
    assert.equal(noMatch.length, 0);
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
    filePath: "/tmp/test.pdf",
    blocks: [{ blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
      text: "aging in China is a topic", charStart: 0, charEnd: 26, lineStart: 1, lineEnd: 1, isReferenceLike: false }],
  });

  const entry = readyEntry(docKey, "ITEM1", "Test", "/tmp/test.pdf");
  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    await client.rebuildIndex([entry]);
    // Unbalanced quotes should not throw, should fall back to sanitized query
    const results = await client.searchDocs('"aging in', 10);
    assert.equal(results.length, 1);

    // A dangling operator survives the fallback; it is the user's query to
    // fix, so it surfaces as a syntax error, not an internal one.
    for (const query of ["AND", "NOT", "aging OR", "(((", "???", '"', "::", "，，"]) {
      await assert.rejects(client.searchDocs(query, 10), KeywordQuerySyntaxError, query);
      await assert.rejects(client.searchBlocks(query, 10), KeywordQuerySyntaxError, query);
    }
  } finally {
    await client.close();
  }
});

test("buildFtsQuery rejects a leading minus instead of silently including the term", () => {
  // FTS5 has no "-term" exclusion; the old fallback stripped the minus and
  // searched for the very term the user meant to exclude.
  for (const query of [
    "aging -China",
    "-China",
    'aging -"in China"',
    "aging -(China OR Japan)",
    "aging (-China)",
    "aging - China",
    "aging －China",
    "老龄化 －中国",
  ]) {
    assert.throws(() => buildFtsQuery(query), KeywordQuerySyntaxError, query);
  }
  // A spaced dash may be a range rather than an exclusion; say how to keep both.
  assert.throws(() => buildFtsQuery("1990 - 2000"), /drop the "-"/);
  // Hyphens inside words are not operators.
  assert.equal(buildFtsQuery("COVID-19 state-building"), '"COVID-19" "state-building"');
  assert.equal(buildFtsQuery('"anti -China"'), '"anti -China"');
});

test("buildFtsQuery quotes words with punctuation inside, which FTS5 barewords cannot hold", () => {
  assert.equal(buildFtsQuery("Olson's logic"), '"Olson\'s" logic');
  assert.equal(buildFtsQuery("U.S. policy"), '"U.S." policy');
  assert.equal(buildFtsQuery("10.1080/00220388"), '"10.1080/00220388"');
  assert.equal(buildFtsQuery("COVID-19 NEAR/5 vaccine"), 'NEAR( "COVID-19" vaccine, 5)');
  assert.equal(buildFtsQuery("state-build*"), '"state-build" *');
  // Already-quoted phrases and the NEAR distance are left alone.
  assert.equal(buildFtsQuery('"COVID-19 vaccine"'), '"COVID-19 vaccine"');
  assert.equal(buildFtsQuery("NEAR/5 foo"), "NEAR/5 foo");
});

test("search keeps operators on a query with hyphenated words", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-db-hyphen-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });
  const docKey = "e".repeat(40);
  writeValidManifest(manifestsDir, docKey, "COVID-19 vaccine rollout in the state-building era");
  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    await client.rebuildIndex([readyEntry(docKey, `ITEM-${docKey}`, "Test", `/tmp/${docKey}.pdf`)]);
    // Unquoted, COVID-19 used to fail FTS5 and fall back to a stripped query
    // that loses the NEAR distance and the prefix operator.
    assert.equal((await client.searchDocs("COVID-19 NEAR/5 vaccine", 10)).length, 1);
    assert.equal((await client.searchDocs("COVID-19 roll*", 10)).length, 1);
    assert.equal((await client.searchDocs("state-building NOT COVID-19", 10)).length, 0);
  } finally {
    await client.close();
  }
});

function writeValidManifest(manifestsDir: string, docKey: string, text: string): string {
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  writeManifestFile(manifestPath, {
    docKey, itemKey: `ITEM-${docKey}`, title: "Test", authors: ["A"],
    filePath: `/tmp/${docKey}.pdf`,
    blocks: [{ blockIndex: 0, blockType: "paragraph", sectionPath: ["Body"],
      text, charStart: 0, charEnd: text.length, lineStart: 1, lineEnd: 1, isReferenceLike: false }],
  });
  return manifestPath;
}

test("rebuildIndex skips entries with unreadable manifests and indexes the rest", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-db-skip-rebuild-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });

  const goodDocKey = "a".repeat(40);
  const corruptDocKey = "b".repeat(40);
  writeValidManifest(manifestsDir, goodDocKey, "cadres manage resources");
  const corruptManifestPath = join(manifestsDir, `${corruptDocKey}${MANIFEST_EXT}`);
  // Non-gzip bytes (no 0x1f 0x8b magic) make readManifestFile throw.
  writeFileSync(corruptManifestPath, "this is not a gzip manifest");

  const goodEntry = readyEntry(goodDocKey, "GOOD", "Good", "/tmp/good.pdf");
  const corruptEntry = readyEntry(corruptDocKey, "BAD", "Bad", "/tmp/bad.pdf");

  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    const { skippedDocKeys } = await client.rebuildIndex([goodEntry, corruptEntry]);
    assert.deepEqual(skippedDocKeys, [corruptDocKey]);
    assert.equal((await client.searchDocs("cadres", 10)).length, 1);
    assert.deepEqual(await client.searchDocs("Bad", 10), []);
  } finally {
    await client.close();
  }
});

test("updateIndex leaves existing rows when a manifest turns unreadable", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-db-skip-update-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "c".repeat(40);
  const manifestPath = writeValidManifest(manifestsDir, docKey, "dangwei shuji appointed");
  const entry = readyEntry(docKey, "ITEM", "Test", "/tmp/test.pdf");

  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    await client.rebuildIndex([entry]);
    assert.equal((await client.searchDocs("dangwei", 10)).length, 1);

    // Corrupt the manifest, then re-run the incremental update for that entry.
    writeFileSync(manifestPath, "no longer a gzip manifest");
    const { skippedDocKeys } = await client.updateIndex([entry], []);
    assert.deepEqual(skippedDocKeys, [docKey]);
    // Stale-but-searchable: the previously indexed rows are left in place.
    assert.equal((await client.searchDocs("dangwei", 10)).length, 1);
  } finally {
    await client.close();
  }
});

test("updateIndex still deletes rows when a manifest goes missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-keyword-db-missing-update-"));
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  mkdirSync(manifestsDir, { recursive: true });

  const docKey = "e".repeat(40);
  const manifestPath = writeValidManifest(manifestsDir, docKey, "resources allocated by cadres");
  const entry = readyEntry(docKey, "ITEM", "Test", "/tmp/test.pdf");

  const client = await openKeywordIndex(createConfig(dataDir));
  try {
    await client.rebuildIndex([entry]);
    assert.equal((await client.searchDocs("allocated", 10)).length, 1);

    // A removed attachment: the manifest file is gone entirely.
    rmSync(manifestPath);
    const { skippedDocKeys } = await client.updateIndex([entry], []);
    assert.deepEqual(skippedDocKeys, []);
    assert.deepEqual(await client.searchDocs("allocated", 10), []);
  } finally {
    await client.close();
  }
});
