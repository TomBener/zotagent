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
