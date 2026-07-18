import test from "node:test";
import assert from "node:assert/strict";

import {
  CJK_CHAR_RE,
  cjkFlexiblePatternSource,
  escapeRegExp,
  HAN_CHAR_RE,
  isCjkChar,
} from "../../src/cjk.js";

test("isCjkChar accepts exactly one Han/kana/Hangul character", () => {
  assert.equal(isCjkChar("新"), true);
  assert.equal(isCjkChar("の"), true);
  assert.equal(isCjkChar("한"), true);
  assert.equal(isCjkChar("a"), false);
  assert.equal(isCjkChar("新疆"), false); // two chars — not a single-char token
  assert.equal(isCjkChar(""), false);
  assert.equal(isCjkChar(undefined), false);
});

test("CJK_CHAR_RE is a contains-test; HAN_CHAR_RE is deliberately Han-only", () => {
  assert.equal(CJK_CHAR_RE.test("about 新疆 history"), true);
  assert.equal(CJK_CHAR_RE.test("latin only"), false);
  // kana must NOT trigger the opencc gate — nothing to fold there.
  assert.equal(HAN_CHAR_RE.test("ひらがな"), false);
  assert.equal(HAN_CHAR_RE.test("新疆"), true);
});

test("escapeRegExp neutralizes every regex metacharacter", () => {
  const pattern = new RegExp(`^${escapeRegExp("a.b*c(d)|[e]$")}$`, "u");
  assert.equal(pattern.test("a.b*c(d)|[e]$"), true);
  assert.equal(pattern.test("aXbbc(d)|[e]$"), false);
});

test("cjkFlexiblePatternSource tolerates OCR spacing between adjacent CJK chars", () => {
  const { source, containsCjk } = cjkFlexiblePatternSource("地質調查");
  assert.equal(containsCjk, true);
  const re = new RegExp(source, "gu");
  assert.ok(re.test("地 質 調 查")); // OCR-segmented
  re.lastIndex = 0;
  assert.ok(re.test("地質調查")); // compact
  re.lastIndex = 0;
  assert.ok(!re.test("地質調杳查".replace("調", "X")));
});

test("cjkFlexiblePatternSource maps whitespace runs to \\s+ and escapes the rest", () => {
  const { source, containsCjk } = cjkFlexiblePatternSource("land  reform (1950)");
  assert.equal(containsCjk, false);
  const re = new RegExp(source, "u");
  assert.ok(re.test("land reform (1950)"));
  assert.ok(re.test("land\n\treform (1950)"));
  assert.ok(!re.test("land reform 1950"));
});

test("cjkFlexiblePatternSource does not stretch across CJK–Latin joints", () => {
  // \s* is only inserted between two adjacent CJK characters, matching what
  // segmentCjk produces at index time.
  const { source } = cjkFlexiblePatternSource("新疆is邊疆");
  const re = new RegExp(source, "gu");
  assert.ok(re.test("新 疆is邊 疆"));
  re.lastIndex = 0;
  assert.ok(!re.test("新 疆 is 邊 疆".replace(/is/u, "i s")));
});
