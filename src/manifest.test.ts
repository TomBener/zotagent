import test from "node:test";
import assert from "node:assert/strict";

import { buildPdfManifest } from "./manifest.js";
import { mapChunkToBlockRange } from "./engine.js";

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
