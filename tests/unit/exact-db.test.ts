import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openExactIndex } from "../../src/exact-db.js";
import type { AppConfig } from "../../src/types.js";

function createConfig(dataDir: string): AppConfig {
  return {
    bibliographyJsonPath: "/tmp/bibliography.json",
    attachmentsRoot: "/tmp/attachments",
    dataDir,
    warnings: [],
  };
}

function writeNormalized(normalizedDir: string, docKey: string, content: string): void {
  writeFileSync(join(normalizedDir, `${docKey}.md`), content, "utf-8");
}

test("openExactIndex searches Chinese and English text in normalized files", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-exact-db-"));
  const dataDir = join(root, "data");
  const normalizedDir = join(dataDir, "normalized");
  mkdirSync(normalizedDir, { recursive: true });

  const leeDocKey = "a".repeat(40);
  const chanDocKey = "b".repeat(40);

  writeNormalized(
    normalizedDir,
    leeDocKey,
    "The DHA programme promotes market selection and recruitment (shichanghua xuanpin 市場化選聘).",
  );
  writeNormalized(
    normalizedDir,
    chanDocKey,
    "The top leader is the company party secretary (dangwei shuji).",
  );

  const client = await openExactIndex(createConfig(dataDir));
  try {
    const chineseSubstring = await client.searchExactCandidates("選聘", 10);
    assert.deepEqual(chineseSubstring.map((c) => c.docKey), [leeDocKey]);

    const chinesePhrase = await client.searchExactCandidates("市場化選聘", 10);
    assert.deepEqual(chinesePhrase.map((c) => c.docKey), [leeDocKey]);

    const englishPhrase = await client.searchExactCandidates("dangwei shuji", 10);
    assert.deepEqual(englishPhrase.map((c) => c.docKey), [chanDocKey]);

    const missing = await client.searchExactCandidates("nonexistent phrase", 10);
    assert.deepEqual(missing, []);
  } finally {
    await client.close();
  }
});

test("searchExactCandidates preserves case, separator, and full-width normalization", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-exact-db-normalized-"));
  const dataDir = join(root, "data");
  const normalizedDir = join(dataDir, "normalized");
  mkdirSync(normalizedDir, { recursive: true });

  const dashedDocKey = "c".repeat(40);
  const fullWidthDocKey = "d".repeat(40);

  writeNormalized(normalizedDir, dashedDocKey, "The top leader is Dangwei-Shuji.");
  writeNormalized(normalizedDir, fullWidthDocKey, "The top leader is ｄａｎｇｗｅｉ ｓｈｕｊｉ.");

  const client = await openExactIndex(createConfig(dataDir));
  try {
    const results = await client.searchExactCandidates("dangwei shuji", 10);
    assert.deepEqual(results.map((result) => result.docKey), [dashedDocKey, fullWidthDocKey]);
  } finally {
    await client.close();
  }
});

test("searchExactCandidates ranks by match count", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-exact-db-rank-"));
  const dataDir = join(root, "data");
  const normalizedDir = join(dataDir, "normalized");
  mkdirSync(normalizedDir, { recursive: true });

  const fewDocKey = "c".repeat(40);
  const manyDocKey = "d".repeat(40);

  writeNormalized(normalizedDir, fewDocKey, "cadres in local government.");
  writeNormalized(
    normalizedDir,
    manyDocKey,
    "cadres are promoted. cadres manage resources. cadres lead teams.",
  );

  const client = await openExactIndex(createConfig(dataDir));
  try {
    const results = await client.searchExactCandidates("cadres", 10);
    assert.equal(results.length, 2);
    assert.equal(results[0]!.docKey, manyDocKey, "doc with more matches should rank first");
    assert.equal(results[0]!.score, 3);
    assert.equal(results[1]!.docKey, fewDocKey);
    assert.equal(results[1]!.score, 1);
  } finally {
    await client.close();
  }
});

test("searchExactCandidates ranks after scanning all candidates, not just an early prefix", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-exact-db-deep-rank-"));
  const dataDir = join(root, "data");
  const normalizedDir = join(dataDir, "normalized");
  mkdirSync(normalizedDir, { recursive: true });

  for (let i = 0; i < 35; i++) {
    const docKey = i.toString(16).padStart(40, "0");
    writeNormalized(normalizedDir, docKey, "cadres are mentioned once.");
  }
  const highScoreDocKey = "f".repeat(40);
  writeNormalized(
    normalizedDir,
    highScoreDocKey,
    "cadres lead teams. cadres allocate resources. cadres manage promotions.",
  );

  const client = await openExactIndex(createConfig(dataDir));
  try {
    const results = await client.searchExactCandidates("cadres", 3);
    assert.equal(results[0]!.docKey, highScoreDocKey);
    assert.equal(results[0]!.score, 3);
  } finally {
    await client.close();
  }
});

test("searchExactCandidates returns empty when normalized dir is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-exact-db-empty-"));
  const dataDir = join(root, "data");
  // do not create normalizedDir

  const client = await openExactIndex(createConfig(dataDir));
  try {
    const results = await client.searchExactCandidates("anything", 10);
    assert.deepEqual(results, []);
  } finally {
    await client.close();
  }
});

test("searchExactCandidates respects limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-exact-db-limit-"));
  const dataDir = join(root, "data");
  const normalizedDir = join(dataDir, "normalized");
  mkdirSync(normalizedDir, { recursive: true });

  for (let i = 0; i < 5; i++) {
    const docKey = String(i).repeat(40);
    writeNormalized(normalizedDir, docKey, `This document mentions cadres.`);
  }

  const client = await openExactIndex(createConfig(dataDir));
  try {
    const results = await client.searchExactCandidates("cadres", 2);
    assert.equal(results.length, 2);
  } finally {
    await client.close();
  }
});

test("searchExactCandidates throws on empty query", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-exact-db-empty-q-"));
  const dataDir = join(root, "data");
  const normalizedDir = join(dataDir, "normalized");
  mkdirSync(normalizedDir, { recursive: true });

  const client = await openExactIndex(createConfig(dataDir));
  try {
    await assert.rejects(
      () => client.searchExactCandidates("", 10),
      { message: "Exact search text cannot be empty." },
    );
  } finally {
    await client.close();
  }
});
