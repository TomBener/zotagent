import test from "node:test";
import assert from "node:assert/strict";

import { findExactPhraseBlockRange, normalizeExactText } from "../../src/exact.js";
import type { AttachmentManifest, ManifestBlock } from "../../src/types.js";

function block(blockIndex: number, text: string): ManifestBlock {
  return {
    blockIndex,
    blockType: "paragraph",
    sectionPath: ["Body"],
    text,
    charStart: 0,
    charEnd: text.length,
    lineStart: 1,
    lineEnd: 1,
    isReferenceLike: false,
  };
}

function manifest(blocks: ManifestBlock[]): AttachmentManifest {
  return {
    docKey: "a".repeat(40),
    itemKey: "ITEM1",
    title: "Test",
    authors: ["A"],
    filePath: "/tmp/test.pdf",
    normalizedPath: "/tmp/test.md",
    blocks,
  };
}

test("normalizeExactText collapses whitespace between adjacent CJK characters", () => {
  assert.equal(normalizeExactText("党 委 书 记"), "党委书记");
  assert.equal(normalizeExactText("独 山 子 油 矿"), "独山子油矿");
  assert.equal(normalizeExactText("副书记 党委"), "副书记 党委");
  assert.equal(normalizeExactText("party secretary"), "party secretary");
  assert.equal(normalizeExactText("Agent 通 信"), "agent 通信");
});

test("findExactPhraseBlockRange finds phrases across block boundaries", () => {
  const result = findExactPhraseBlockRange(
    manifest([
      block(10, "The policy made China demographically"),
      block(20, "old before economically rich per capita."),
    ]),
    "demographically old before economically rich",
  );

  assert.deepEqual(result, { blockStart: 10, blockEnd: 20 });
});

test("findExactPhraseBlockRange can require token-boundary phrase matches", () => {
  const doc = manifest([
    block(10, "Here alpha beta appears together."),
    block(20, "党 委 书 记 是 关 键 岗 位"),
  ]);

  assert.deepEqual(
    findExactPhraseBlockRange(doc, "alpha beta", { tokenBoundaries: true }),
    { blockStart: 10, blockEnd: 10 },
  );
  assert.equal(findExactPhraseBlockRange(doc, "lpha beta", { tokenBoundaries: true }), null);
  assert.equal(findExactPhraseBlockRange(doc, "alpha bet", { tokenBoundaries: true }), null);
  assert.deepEqual(
    findExactPhraseBlockRange(doc, "委书", { tokenBoundaries: true }),
    { blockStart: 20, blockEnd: 20 },
  );
});

test("findExactPhraseBlockRange returns the narrowest matching block span", () => {
  const result = findExactPhraseBlockRange(
    manifest([
      block(10, "old"),
      block(20, "before rich appears across blocks"),
      block(30, "The phrase old before rich also appears in one block."),
    ]),
    "old before rich",
  );

  assert.deepEqual(result, { blockStart: 30, blockEnd: 30 });
});

test("findExactPhraseBlockRange matches CJK phrases despite OCR-style spacing", () => {
  const result = findExactPhraseBlockRange(
    manifest([
      block(10, "党 委 书 记 是 关 键 岗 位"),
    ]),
    "党委书记",
  );

  assert.deepEqual(result, { blockStart: 10, blockEnd: 10 });
});

test("normalizeExactText folds traditional Chinese to simplified", () => {
  assert.equal(normalizeExactText("繁體中文"), "繁体中文");
  assert.equal(normalizeExactText("開發新疆"), "开发新疆");
  // Already simplified text stays simplified.
  assert.equal(normalizeExactText("开发新疆"), "开发新疆");
  // Mixed scripts keep their non-Han portions untouched.
  assert.equal(normalizeExactText("Reform 改革開放 Era"), "reform 改革开放 era");
});

test("findExactPhraseBlockRange matches across traditional/simplified variants", () => {
  // Traditional query against a simplified document.
  const tradVsSimp = findExactPhraseBlockRange(
    manifest([block(5, "本文讨论开发新疆的人力财力问题。")]),
    "開發新疆",
  );
  assert.deepEqual(tradVsSimp, { blockStart: 5, blockEnd: 5 });

  // Simplified query against a traditional document.
  const simpVsTrad = findExactPhraseBlockRange(
    manifest([block(7, "本文討論開發新疆的人力財力問題。")]),
    "开发新疆",
  );
  assert.deepEqual(simpVsTrad, { blockStart: 7, blockEnd: 7 });
});

test("findExactPhraseBlockRange handles long manifests with no match quickly", () => {
  const blocks = Array.from({ length: 5000 }, (_, index) =>
    block(index, `This unrelated block ${index} mentions old material before another rich example.`),
  );

  const start = Date.now();
  const result = findExactPhraseBlockRange(manifest(blocks), "old before rich");
  const elapsedMs = Date.now() - start;

  assert.equal(result, null);
  assert.ok(elapsedMs < 1000, `expected no-match scan under 1000ms, got ${elapsedMs}ms`);
});
