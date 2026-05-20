import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearPdfVerticalCache, pdfHasVerticalText } from "../../src/pdf-vertical.js";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pdf-vertical-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("pdfHasVerticalText returns true when the file contains an Identity-V font encoding", () => {
  withTempDir((dir) => {
    clearPdfVerticalCache();
    const file = join(dir, "vertical.pdf");
    writeFileSync(
      file,
      "%PDF-1.3\n10 0 obj <</Type/Font/Subtype/Type0/Encoding/Identity-V>> endobj\n%%EOF\n",
    );
    assert.equal(pdfHasVerticalText(file), true);
  });
});

test("pdfHasVerticalText returns false for files without Identity-V", () => {
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

test("pdfHasVerticalText finds Identity-V across chunk boundaries", () => {
  withTempDir((dir) => {
    clearPdfVerticalCache();
    const file = join(dir, "chunked.pdf");
    const chunk = 1024 * 1024;
    const marker = "/Identity-V";
    const splitAt = chunk - 5;
    const prefix = Buffer.alloc(splitAt, 0x20);
    const tail = Buffer.from(`${marker}\n%%EOF\n`, "latin1");
    writeFileSync(file, Buffer.concat([prefix, tail]));
    assert.equal(pdfHasVerticalText(file), true);
  });
});

test("pdfHasVerticalText returns false when the file cannot be opened", () => {
  clearPdfVerticalCache();
  assert.equal(pdfHasVerticalText("/nonexistent-pdf-path-xyz.pdf"), false);
});
