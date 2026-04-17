import test from "node:test";
import assert from "node:assert/strict";

import { buildPdfManifest, mergeManifestsForItem } from "../../src/manifest.js";
import { mapChunkToBlockRange } from "../../src/engine.js";
import type { AttachmentManifest } from "../../src/types.js";

test("buildPdfManifest creates positioned blocks from ODL json", () => {
  const built = buildPdfManifest(
    {
      docKey: "a".repeat(40),
      itemKey: "ITEM1",
      title: "Paper",
      authors: ["Jane Smith"],
      filePath: "/tmp/paper.pdf",
      fileExt: "pdf",
      exists: true,
      supported: true,
    },
    "# ignored fallback",
    JSON.stringify([
      { type: "heading", content: "Introduction", "heading level": 1, "page number": 1 },
      { type: "paragraph", content: "This is the first paragraph.", "page number": 1 },
      { type: "list", content: "A listed point", "page number": 1 },
      { type: "paragraph", content: "Smith, J. (2022). Example reference.", "page number": 2 },
    ]),
    "/tmp/a.md",
  );

  assert.equal(built.manifest.blocks.length, 4);
  assert.equal(built.manifest.blocks[0]!.lineStart, 1);
  assert.equal(built.manifest.blocks[0]!.text, "Introduction");
  assert.equal(built.manifest.blocks[2]!.blockType, "list item");
  assert.equal(built.manifest.blocks[3]!.isReferenceLike, true);
  assert.match(built.markdown, /^# Introduction/m);
  assert.match(built.markdown, /^- A listed point/m);
});

test("mapChunkToBlockRange maps qmd chunk offsets back to manifest blocks", () => {
  const built = buildPdfManifest(
    {
      docKey: "b".repeat(40),
      itemKey: "ITEM2",
      title: "Paper",
      authors: [],
      filePath: "/tmp/paper.pdf",
      fileExt: "pdf",
      exists: true,
      supported: true,
    },
    "",
    JSON.stringify([
      { type: "heading", content: "Methods", "heading level": 1, "page number": 1 },
      { type: "paragraph", content: "Methods paragraph one.", "page number": 1 },
      { type: "paragraph", content: "Methods paragraph two.", "page number": 1 },
    ]),
    "/tmp/b.md",
  );

  const chunkPos = built.markdown.indexOf("Methods paragraph one.");
  const mapped = mapChunkToBlockRange(
    built.manifest,
    chunkPos,
    "Methods paragraph one.\n\nMethods paragraph two.",
  );

  assert.deepEqual(mapped, { blockStart: 1, blockEnd: 2 });
});

function makeManifest(
  docKey: string,
  filePath: string,
  texts: string[],
): AttachmentManifest {
  let char = 0;
  let line = 1;
  const blocks = texts.map((text, index) => {
    if (index > 0) {
      char += 2;
      line += 2;
    }
    const start = char;
    const lineStart = line;
    char += text.length;
    return {
      blockIndex: index,
      sectionPath: [],
      blockType: "paragraph" as const,
      text,
      charStart: start,
      charEnd: char,
      lineStart,
      lineEnd: line,
      isReferenceLike: false,
    };
  });
  return {
    docKey,
    itemKey: "ITEM1",
    title: "Merged paper",
    authors: ["A"],
    filePath,
    normalizedPath: `/tmp/${docKey}.md`,
    blocks,
  };
}

test("mergeManifestsForItem returns a single manifest unchanged", () => {
  const manifest = makeManifest("a".repeat(40), "/tmp/main.pdf", ["Only block."]);
  const merged = mergeManifestsForItem([manifest]);
  assert.equal(merged, manifest);
});

test("mergeManifestsForItem concatenates blocks with a separator and monotonic indices", () => {
  const manifestA = makeManifest("a".repeat(40), "/tmp/main.pdf", ["First A.", "Second A."]);
  const manifestB = makeManifest("b".repeat(40), "/tmp/appendix.pdf", ["First B."]);

  const merged = mergeManifestsForItem([manifestA, manifestB]);

  // 2 blocks from A + 1 separator + 1 block from B = 4 blocks total, indices 0..3.
  assert.equal(merged.blocks.length, 4);
  assert.deepEqual(merged.blocks.map((b) => b.blockIndex), [0, 1, 2, 3]);

  // Separator block sits between the two attachments and references the second file.
  assert.equal(merged.blocks[2]!.blockType, "heading");
  assert.match(merged.blocks[2]!.text, /Attachment: appendix\.pdf/);

  // char/line cursors advance strictly and don't overlap.
  for (let i = 1; i < merged.blocks.length; i += 1) {
    assert.ok(
      merged.blocks[i]!.charStart >= merged.blocks[i - 1]!.charEnd,
      `block ${i} charStart should be >= previous charEnd`,
    );
    assert.ok(
      merged.blocks[i]!.lineStart >= merged.blocks[i - 1]!.lineEnd,
      `block ${i} lineStart should be >= previous lineEnd`,
    );
  }

  // itemKey is preserved, filePath/normalizedPath are cleared in the virtual merge.
  assert.equal(merged.itemKey, "ITEM1");
  assert.equal(merged.docKey, "item:ITEM1");
  assert.equal(merged.filePath, "");
  assert.equal(merged.normalizedPath, "");

  // Blocks from B still carry their original text.
  assert.equal(merged.blocks[3]!.text, "First B.");
});
