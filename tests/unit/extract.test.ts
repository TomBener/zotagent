import test from "node:test";
import assert from "node:assert/strict";
import { buildArgs } from "@opendataloader/pdf";

import { garbledTextRatios, odlConvertOptions, odlYieldShortfall } from "../../src/extract.js";

function odlJson(pages: number): string {
  return JSON.stringify({ "file name": "x.pdf", "number of pages": pages, kids: [] });
}

test("odlConvertOptions disables the tiny content-safety rule", () => {
  const options = odlConvertOptions("/tmp/out", "markdown,json", false);
  assert.equal(options.contentSafetyOff, "tiny");
  assert.equal(options.outputDir, "/tmp/out");
  assert.equal(options.format, "markdown,json");
  assert.equal(options.readingOrder, undefined);
});

test("odlConvertOptions turns reading order off for vertical text", () => {
  assert.equal(odlConvertOptions("/tmp/out", "text", true).readingOrder, "off");
});

test("odlConvertOptions reaches the CLI as --content-safety-off tiny", () => {
  const args = buildArgs(odlConvertOptions("/tmp/out", "markdown,json", false));
  const at = args.indexOf("--content-safety-off");
  assert.notEqual(at, -1);
  assert.equal(args[at + 1], "tiny");
});

test("odlYieldShortfall reports a document that extracted to almost nothing", () => {
  const shortfall = odlYieldShortfall("# DOI:10.14167/j.zjss.2023.07.012", odlJson(12));
  assert.deepEqual(shortfall, { chars: 33, pages: 12 });
});

test("odlYieldShortfall accepts a normal yield", () => {
  assert.equal(odlYieldShortfall("x".repeat(30_000), odlJson(12)), undefined);
});

test("odlYieldShortfall measures against the threshold per page", () => {
  // 50 chars/page is the floor: at the floor exactly, the yield passes.
  assert.equal(odlYieldShortfall("x".repeat(500), odlJson(10)), undefined);
  assert.deepEqual(odlYieldShortfall("x".repeat(499), odlJson(10)), { chars: 499, pages: 10 });
});

test("odlYieldShortfall ignores surrounding whitespace when counting", () => {
  assert.deepEqual(odlYieldShortfall(`\n\n  ${"x".repeat(10)}\n  \n`, odlJson(8)), {
    chars: 10,
    pages: 8,
  });
});

test("odlYieldShortfall holds no opinion on short documents", () => {
  // A scanned map or a one-page plate is text-free by nature, not by failure.
  assert.equal(odlYieldShortfall("", odlJson(1)), undefined);
  assert.equal(odlYieldShortfall("", odlJson(3)), undefined);
  assert.deepEqual(odlYieldShortfall("", odlJson(4)), { chars: 0, pages: 4 });
});

test("odlYieldShortfall holds no opinion without a usable page count", () => {
  assert.equal(odlYieldShortfall("", "not json at all"), undefined);
  assert.equal(odlYieldShortfall("", JSON.stringify({ kids: [] })), undefined);
  assert.equal(odlYieldShortfall("", JSON.stringify({ "number of pages": 0 })), undefined);
  assert.equal(odlYieldShortfall("", JSON.stringify({ "number of pages": "12" })), undefined);
  assert.equal(odlYieldShortfall("", JSON.stringify(null)), undefined);
});

test("garbledTextRatios catches character-map noise", () => {
  // Real pdftotext output from a PDF whose fonts have no usable ToUnicode.
  const noise = `!"#$ "#$ %&''()*'("+ ,*+()(-. (# /'0"# 12(#"3 !"#$%&'( )*&(+
    !"#$%!&$ '( )*+, -.)+/01 ' 12-3+(1 )*1 450+)+/, 56 7.8-( 0-(9 91:105431()`.repeat(4);
  const ratios = garbledTextRatios(noise);
  assert.ok(ratios, "expected the noise to be judged garbled");
  assert.ok(ratios.letterRatio < 0.5);
  assert.ok(ratios.symbolRatio > 0.05);
});

test("garbledTextRatios passes ordinary English and Chinese prose", () => {
  const english = `The worst thing one can do with words, wrote George Orwell half a
    century ago, is to surrender to them. If language is to be an instrument for
    expressing and not for concealing or preventing thought, we must resist it.`;
  const chinese = `外嫁女参与集体收益分配纠纷的实质是作为政治自由的村民自治与外嫁女的平等权冲突，
    对该类案件的裁判涉及宪法和法律中的平等规范与村民自治规范的适用。在规范援引方式上，
    法院有三种选择：援引宪法中的平等规范、援引法律中的平等规范和村民自治规范。`;
  assert.equal(garbledTextRatios(english), undefined);
  assert.equal(garbledTextRatios(chinese), undefined);
});

test("garbledTextRatios needs both signals before condemning text", () => {
  // Letter-poor but symbol-clean: a statistical table is legitimate output.
  const table = "1990  12,345  6.7   1991  13,004  6.9   1992  14,220  7.1  ".repeat(12);
  assert.equal(garbledTextRatios(table), undefined);
  // Symbol-rich but letter-dense: an annotated scan is legitimate output.
  const annotated = "見前引書 #12 及 @卷三 頁四十五 <案語> 又見 /補遺/ 條目 ".repeat(12);
  assert.equal(garbledTextRatios(annotated), undefined);
});

test("garbledTextRatios holds no opinion on short output", () => {
  assert.equal(garbledTextRatios("!\"#$%&'()*+"), undefined);
});
