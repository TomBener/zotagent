import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearPdfVerticalCache,
  pdfBytesIndicateVerticalEncoding,
  pdfHasVerticalText,
  singleCjkWordRatio,
} from "../../src/pdf-vertical.js";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pdf-vertical-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("pdfBytesIndicateVerticalEncoding returns true when /Identity-V is present", () => {
  withTempDir((dir) => {
    const file = join(dir, "vertical.pdf");
    writeFileSync(
      file,
      "%PDF-1.3\n10 0 obj <</Type/Font/Subtype/Type0/Encoding/Identity-V>> endobj\n%%EOF\n",
    );
    assert.equal(pdfBytesIndicateVerticalEncoding(file), true);
  });
});

test("pdfBytesIndicateVerticalEncoding returns false when only /Identity-H is present", () => {
  withTempDir((dir) => {
    const file = join(dir, "horizontal.pdf");
    writeFileSync(
      file,
      "%PDF-1.6\n10 0 obj <</Type/Font/Subtype/Type0/Encoding/Identity-H>> endobj\n%%EOF\n",
    );
    assert.equal(pdfBytesIndicateVerticalEncoding(file), false);
  });
});

test("pdfBytesIndicateVerticalEncoding finds /Identity-V across chunk boundaries", () => {
  withTempDir((dir) => {
    const file = join(dir, "chunked.pdf");
    const chunk = 1024 * 1024;
    const splitAt = chunk - 5;
    const prefix = Buffer.alloc(splitAt, 0x20);
    const tail = Buffer.from("/Identity-V\n%%EOF\n", "latin1");
    writeFileSync(file, Buffer.concat([prefix, tail]));
    assert.equal(pdfBytesIndicateVerticalEncoding(file), true);
  });
});

test("pdfBytesIndicateVerticalEncoding returns false when the file cannot be opened", () => {
  assert.equal(pdfBytesIndicateVerticalEncoding("/nonexistent-pdf-path-xyz.pdf"), false);
});

test("singleCjkWordRatio counts single-CJK words from pdftotext -bbox output", () => {
  // A vertical PDF's bbox stream emits each glyph as its own positioned word.
  const verticalXml = `
<doc>
  <page>
    <word xMin="100" yMin="50" xMax="120" yMax="70">予</word>
    <word xMin="100" yMin="71" xMax="120" yMax="91">友</word>
    <word xMin="100" yMin="92" xMax="120" yMax="112">章</word>
    <word xMin="100" yMin="113" xMax="120" yMax="133">君</word>
    <word xMin="100" yMin="134" xMax="120" yMax="154">演</word>
  </page>
</doc>`;
  assert.equal(singleCjkWordRatio(verticalXml), 1.0);
});

test("singleCjkWordRatio is low for horizontal multi-character word streams", () => {
  const horizontalXml = `
<doc>
  <page>
    <word xMin="100" yMin="50" xMax="200" yMax="70">现代中国思想</word>
    <word xMin="210" yMin="50" xMax="320" yMax="70">的兴起</word>
    <word xMin="100" yMin="80" xMax="200" yMax="100">第一卷</word>
  </page>
</doc>`;
  assert.equal(singleCjkWordRatio(horizontalXml), 0);
});

test("singleCjkWordRatio handles empty input", () => {
  assert.equal(singleCjkWordRatio(""), 0);
  assert.equal(singleCjkWordRatio("<doc></doc>"), 0);
});

test("singleCjkWordRatio ignores ASCII-only single-character words", () => {
  const xml = `
<doc>
  <page>
    <word xMin="0" yMin="0" xMax="10" yMax="10">a</word>
    <word xMin="0" yMin="0" xMax="10" yMax="10">b</word>
    <word xMin="0" yMin="0" xMax="10" yMax="10">2</word>
  </page>
</doc>`;
  assert.equal(singleCjkWordRatio(xml), 0);
});

test("pdfHasVerticalText returns false for synthetic bytes that pass stage 1 but fail stage 2", () => {
  // The byte sequence contains /Identity-V but is not a valid PDF — pdfinfo
  // will fail, layout stage returns false, the combined detector returns
  // false. This proves the byte scan alone no longer drives a vertical
  // classification: real layout evidence is required.
  withTempDir((dir) => {
    clearPdfVerticalCache();
    const file = join(dir, "stage1-only.pdf");
    writeFileSync(
      file,
      "%PDF-1.3\n10 0 obj <</Type/Font/Subtype/Type0/Encoding/Identity-V>> endobj\n%%EOF\n",
    );
    assert.equal(pdfHasVerticalText(file), false);
  });
});

test("pdfHasVerticalText returns false (and short-circuits stage 2) when bytes lack Identity-V", () => {
  withTempDir((dir) => {
    clearPdfVerticalCache();
    const file = join(dir, "horizontal.pdf");
    writeFileSync(
      file,
      "%PDF-1.6\n10 0 obj <</Type/Font/Subtype/Type0/Encoding/Identity-H>> endobj\n%%EOF\n",
    );
    assert.equal(pdfHasVerticalText(file), false);
  });
});

test("pdfHasVerticalText returns false when the file cannot be opened", () => {
  clearPdfVerticalCache();
  assert.equal(pdfHasVerticalText("/nonexistent-pdf-path-xyz.pdf"), false);
});
