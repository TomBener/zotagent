// The single home for CJK script knowledge. Index-time normalization
// (keyword-db segmentation), query-time rewriting (FTS NEAR expansion), and
// passage handling (reflow joins, anchor patterns, the exact-phrase scanner)
// must all agree on what counts as a CJK character — a drift between any two
// of them produces search misses that only surface on a real index.

/** Character-class source for Han + kana + Hangul. Compose into bigger
 *  regexes (runs, joins); use the ready-made regexes below for plain tests. */
export const CJK_CLASS_SOURCE =
  "[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]";

/** Matches when the string contains at least one CJK character. */
export const CJK_CHAR_RE = new RegExp(CJK_CLASS_SOURCE, "u");

const SINGLE_CJK_CHAR_RE = new RegExp(`^${CJK_CLASS_SOURCE}$`, "u");

/** True when `value` is exactly one CJK character (undefined → false). Also
 *  the right test for space-split tokens that must be single CJK chars. */
export function isCjkChar(value: string | undefined): boolean {
  return value !== undefined && SINGLE_CJK_CHAR_RE.test(value);
}

/** Han specifically — deliberately narrower than the CJK class. This gates
 *  the opencc traditional→simplified converter, which only affects Han text;
 *  kana or Hangul alone must not pay for a conversion pass. */
export const HAN_CHAR_RE = /\p{Script=Han}/u;

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Compile text into a regex source where whitespace runs match `\s+` and
 * adjacent CJK characters additionally tolerate interleaved whitespace
 * (`\s*`) — the shape OCR output takes when it splits CJK text character by
 * character, and the shape the keyword index itself produces via
 * `segmentCjk`. Callers add their own anchors, boundaries, and flags.
 */
export function cjkFlexiblePatternSource(text: string): { source: string; containsCjk: boolean } {
  const chars = [...text];
  let source = "";
  let containsCjk = false;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (/\s/u.test(ch)) {
      source += "\\s+";
      while (/\s/u.test(chars[i + 1] ?? "")) i += 1;
      continue;
    }
    containsCjk ||= isCjkChar(ch);
    source += escapeRegExp(ch);
    const next = chars[i + 1];
    if (isCjkChar(ch) && next !== undefined && isCjkChar(next)) {
      source += "\\s*";
    }
  }
  return { source, containsCjk };
}

function isSegmentWhitespace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t";
}

/**
 * Insert a space between adjacent characters whenever either side is CJK, so
 * FTS5's unicode61 tokenizer indexes each CJK character as its own token.
 * Applied identically at index-write time and query-rewrite time — the two
 * must never drift, or phrase queries stop matching indexed rows.
 */
export function segmentCjk(text: string): string {
  const chars = [...text];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const isCjk = isCjkChar(ch);
    if (out.length > 0 && !isSegmentWhitespace(ch)) {
      const prev = out[out.length - 1]!;
      if (!isSegmentWhitespace(prev)) {
        const prevIsCjk = isCjkChar(prev);
        if (isCjk || prevIsCjk) {
          out.push(" ");
        }
      }
    }
    out.push(ch);
  }
  return out.join("");
}
