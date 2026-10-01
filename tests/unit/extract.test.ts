import test from "node:test";
import assert from "node:assert/strict";
import { buildArgs } from "@opendataloader/pdf";

import { garbledTextRatios, groupForOdlBatches, isOdlStructuralBug, odlConvertOptions, odlYieldShortfall, pdftotextYieldShortfall, scatteredGlyphRatios } from "../../src/extract.js";
import type { AttachmentCatalogEntry } from "../../src/types.js";

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

test("odlConvertOptions never writes images", () => {
  const args = buildArgs(odlConvertOptions("/tmp/out", "markdown,json", false));
  const at = args.indexOf("--image-output");
  assert.notEqual(at, -1);
  assert.equal(args[at + 1], "off");
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

// Real pdftotext output from a 1958 newspaper scan with a broken font map:
// single glyphs from unrelated scripts, each wrapped in control characters.
const SCATTERED_GLYPHS = [
  "ᒪ", "ᴾ", "ᰛ", "ȼ", "᱕", "ᵕ", "ޣ", "ॷ", "п", "Ѡ",
  "ᰅ", "ᘶ", "ᗹ", "ѱ", "Ր", "ཝ", "ѿ", "䗾", "䚉", "䘑",
  "୧", "᯦", "ޡ", "ᶛ", "ᔰ", "䇴", "ᡆ", "ቧ", "㤧", "䳺",
  "Ԣ", "䑅", "䚃", "߼", "ಬ", "ቊ", "਺", "亯", "Ӂ", "ѐ",
].map((glyph) => `\u0003${glyph}\u0003   `).join("").repeat(6);

test("scatteredGlyphRatios catches letters strewn across unrelated scripts", () => {
  // Every glyph is a letter, so the letter/symbol pair passes it as prose.
  assert.equal(garbledTextRatios(SCATTERED_GLYPHS), undefined);
  const ratios = scatteredGlyphRatios(SCATTERED_GLYPHS);
  assert.ok(ratios, "expected the scatter to be judged garbled");
  assert.ok(ratios.topScriptShare < 0.6);
  assert.ok(ratios.isolatedShare > 0.99);
});

test("scatteredGlyphRatios passes prose in one or two writing systems", () => {
  const english = "The worst thing one can do with words is to surrender to them. ".repeat(8);
  const chinese = "外嫁女参与集体收益分配纠纷的实质是作为政治自由的村民自治与外嫁女的平等权冲突。".repeat(8);
  // Kanji, hiragana, and katakana are one writing system, not three scripts.
  const japanese = "近代日本のナショナリズムとアジア主義についての研究ノートである。".repeat(8);
  assert.equal(scatteredGlyphRatios(english), undefined);
  assert.equal(scatteredGlyphRatios(chinese), undefined);
  assert.equal(scatteredGlyphRatios(japanese), undefined);
});

test("scatteredGlyphRatios needs both signals before condemning text", () => {
  // Fully isolated but concentrated: per-character-spaced Chinese is legitimate.
  const spaced = [..."党委书记是干部体系中的关键岗位新疆省政府主席盛世才"].join(" ").repeat(12);
  assert.equal(scatteredGlyphRatios(spaced), undefined);
  // Mixed scripts but in words: a trilingual monograph is legitimate.
  const trilingual = "盛世才与苏联 Советский Союз и Синьцзян the Soviet Union in Xinjiang 1933年 ".repeat(8);
  assert.equal(scatteredGlyphRatios(trilingual), undefined);
  // Fully vocalized text puts a combining mark after nearly every letter
  // (Arabic harakat, Hebrew niqqud, Devanagari matras); the marks are part
  // of the word, so these letters are not isolated.
  const vocalized = (letters: string, mark: string) => [...letters].map((l) => l + mark).join("");
  const philology = [
    vocalized("بتثجحخدذ", "\u064E"),
    vocalized("בגדהוזחט", "\u05B8"),
    vocalized("कखगघचछ", "\u093E"),
    "philology",
  ].join(" ").concat(" ").repeat(12);
  assert.equal(scatteredGlyphRatios(philology), undefined);
});

test("scatteredGlyphRatios holds no opinion on short output", () => {
  assert.equal(scatteredGlyphRatios("ᒪ ᴾ ᰛ ȼ ᱕"), undefined);
});

function pdfAttachment(filePath: string, itemKey: string): AttachmentCatalogEntry {
  return {
    docKey: itemKey.toLowerCase().padEnd(40, "0"), itemKey, title: itemKey, authors: [], filePath,
    fileExt: "pdf", exists: true, supported: true, type: "article-journal",
  };
}

test("groupForOdlBatches never batches stems that collide on a case-insensitive volume", () => {
  const batches = groupForOdlBatches(
    [
      pdfAttachment("/lib/A/Paper.pdf", "ITEMA001"),
      pdfAttachment("/lib/B/paper.pdf", "ITEMB001"),
      pdfAttachment("/lib/C/Caf\u00e9.pdf", "ITEMC001"),
      pdfAttachment("/lib/D/Cafe\u0301.pdf", "ITEMD001"),
      pdfAttachment("/lib/E/Other.pdf", "ITEME001"),
      pdfAttachment("/lib/F/\u039f\u0394\u03a5\u03a3\u03a3\u0395\u03a5\u03a3.pdf", "ITEMF001"),
      pdfAttachment("/lib/G/\u03bf\u03b4\u03c5\u03c3\u03c3\u03b5\u03c5\u03c3.pdf", "ITEMG001"),
    ],
    new Set(),
  );
  for (const batch of batches) {
    const stems = batch.map((a) => a.filePath.split("/").pop()!.replace(/\.pdf$/u, "").normalize("NFC").toUpperCase());
    assert.equal(new Set(stems).size, stems.length, `colliding stems in one batch: ${stems.join(", ")}`);
  }
  assert.equal(batches.flat().length, 7);
});

test("pdftotextYieldShortfall catches a scan whose only text is a download stamp", () => {
  // Real pdftotext output shape: one stamp line per page, a form feed after each.
  const stamped = "Downloaded from JSTOR 2020\n\f".repeat(6);
  assert.deepEqual(pdftotextYieldShortfall(stamped), { chars: 6 * 23, pages: 6 });
});

test("pdftotextYieldShortfall ignores layout padding and exempts short documents", () => {
  const page = `${" ".repeat(400)}${"Ordinary prose with enough words on the page. ".repeat(3)}\n\f`;
  assert.equal(pdftotextYieldShortfall(page.repeat(10)), undefined);
  // Three pages is too short to hold an opinion, however thin.
  assert.equal(pdftotextYieldShortfall("x\n\f".repeat(3)), undefined);
  // No form feeds: page count unknown, no judgement.
  assert.equal(pdftotextYieldShortfall("x"), undefined);
});

// The shape runOdlConvert rejects with: its exit line, then ODL's stderr.
function odlFailure(stderr: string): Error {
  return new Error(`OpenDataLoader PDF extraction exited with code 1.\n\n${stderr}`);
}

test("isOdlStructuralBug routes a processor exception that carries no stack trace", () => {
  // OpenDataLoader 2.5.x logs the message alone; the processor class is gone.
  const error = odlFailure(
    "Oct 01, 2026 5:56:05 PM org.opendataloader.pdf.cli.CLIMain processFile\n" +
      "SEVERE: Exception during processing file /lib/x.pdf: Index 3 out of bounds for length 3",
  );
  assert.equal(isOdlStructuralBug(error), true);
});

test("isOdlStructuralBug still routes a StackOverflowError, which escapes the per-file catch", () => {
  const error = odlFailure(
    'Exception in thread "main" java.lang.StackOverflowError\n\tat java.base/java.util.ArrayList.get(ArrayList.java:427)',
  );
  assert.equal(isOdlStructuralBug(error), true);
});

test("isOdlStructuralBug leaves unreadable and password-protected PDFs alone", () => {
  // An unreadable PDF: its `Error:` line goes to stdout, so stderr holds only INFO lines.
  const invalid = odlFailure(
    "Oct 01, 2026 5:56:05 PM org.opendataloader.pdf.processors.DocumentProcessor preprocessing\n" +
      "INFO: File name: /lib/x.pdf",
  );
  assert.equal(isOdlStructuralBug(invalid), false);
  const locked = odlFailure("Error: 'x.pdf' is password-protected. Use --password option.");
  assert.equal(isOdlStructuralBug(locked), false);
});
