import type { AttachmentManifest } from "./types.js";
import { toSimplified } from "./zh-convert.js";

const SINGLE_CJK_TOKEN = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;

type ExactPhraseOptions = {
  tokenBoundaries?: boolean;
};

function isCjkChar(ch: string | undefined): boolean {
  return ch !== undefined && SINGLE_CJK_TOKEN.test(ch);
}

function hasTokenBoundaryBefore(text: string, offset: number, firstQueryChar: string): boolean {
  if (offset <= 0) return true;
  if (isCjkChar(firstQueryChar)) return true;
  const prev = text[offset - 1];
  return prev === " " || isCjkChar(prev);
}

function hasTokenBoundaryAfter(text: string, offset: number, lastQueryChar: string): boolean {
  if (offset >= text.length) return true;
  if (isCjkChar(lastQueryChar)) return true;
  const next = text[offset];
  return next === " " || isCjkChar(next);
}

function satisfiesTokenBoundaries(
  text: string,
  start: number,
  endExclusive: number,
  query: string,
): boolean {
  const first = query[0];
  const last = query[query.length - 1];
  if (first === undefined || last === undefined) return false;
  return (
    hasTokenBoundaryBefore(text, start, first)
    && hasTokenBoundaryAfter(text, endExclusive, last)
  );
}

function collapseSegmentedCjkRuns(normalized: string): string {
  if (normalized.length === 0) return normalized;

  const tokens = normalized.split(" ");
  const out: string[] = [];
  let singleCharRun: string[] = [];

  const flushSingleCharRun = (): void => {
    if (singleCharRun.length === 0) return;
    out.push(singleCharRun.join(""));
    singleCharRun = [];
  };

  for (const token of tokens) {
    if (SINGLE_CJK_TOKEN.test(token)) {
      singleCharRun.push(token);
      continue;
    }
    flushSingleCharRun();
    out.push(token);
  }

  flushSingleCharRun();
  return out.join(" ");
}

export function normalizeExactText(input: string): string {
  const normalized = toSimplified(input.normalize("NFKC"))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return collapseSegmentedCjkRuns(normalized);
}

export function buildExactIndexText(parts: string[]): string {
  return parts
    .map((part) => normalizeExactText(part))
    .filter((part) => part.length > 0)
    .join(" ");
}

export function buildExactManifestBody(manifest: AttachmentManifest): string {
  return buildExactIndexText(manifest.blocks.map((block) => block.text));
}

export function countExactMatches(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;

  let count = 0;
  let pos = haystack.indexOf(needle);
  while (pos !== -1) {
    count += 1;
    pos = haystack.indexOf(needle, pos + 1);
  }

  return count;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function buildFlexibleCjkPattern(query: string): RegExp | null {
  if (![...query].some((ch) => isCjkChar(ch))) return null;

  const chars = [...query];
  let pattern = "";
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (ch === " ") {
      pattern += "\\s+";
      continue;
    }
    pattern += escapeRegExp(ch);
    const next = chars[i + 1];
    if (isCjkChar(ch) && isCjkChar(next)) {
      pattern += "\\s*";
    }
  }
  return new RegExp(pattern, "gu");
}

export function findExactPhraseBlockRange(
  manifest: AttachmentManifest,
  query: string,
  options: ExactPhraseOptions = {},
): { blockStart: number; blockEnd: number } | null {
  const normalizedQuery = normalizeExactText(query);
  if (normalizedQuery.length === 0) return null;

  const normalizedBlocks: Array<{
    blockIndex: number;
    start: number;
    end: number;
  }> = [];
  let normalizedBody = "";

  for (const block of manifest.blocks) {
    const text = normalizeExactText(block.text);
    if (text.length === 0) continue;

    if (normalizedBody.length > 0) {
      normalizedBody += " ";
    }
    const start = normalizedBody.length;
    normalizedBody += text;
    normalizedBlocks.push({
      blockIndex: block.blockIndex,
      start,
      end: normalizedBody.length,
    });
  }

  if (normalizedBody.length === 0) return null;

  const findBlockForOffset = (offset: number): { blockIndex: number; ordinal: number } | null => {
    let low = 0;
    let high = normalizedBlocks.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const block = normalizedBlocks[mid]!;
      if (offset < block.start) {
        high = mid - 1;
      } else if (offset >= block.end) {
        low = mid + 1;
      } else {
        return { blockIndex: block.blockIndex, ordinal: mid };
      }
    }

    return null;
  };

  let best: { blockStart: number; blockEnd: number; span: number } | null = null;

  const candidateForMatch = (
    matchStart: number,
    matchEndExclusive: number,
  ): { blockStart: number; blockEnd: number; span: number } | null => {
    if (
      options.tokenBoundaries
      && !satisfiesTokenBoundaries(normalizedBody, matchStart, matchEndExclusive, normalizedQuery)
    ) {
      return null;
    }
    const matchEnd = matchEndExclusive - 1;
    const blockStart = findBlockForOffset(matchStart);
    const blockEnd = findBlockForOffset(matchEnd);

    if (blockStart !== null && blockEnd !== null) {
      return {
        blockStart: blockStart.blockIndex,
        blockEnd: blockEnd.blockIndex,
        span: blockEnd.ordinal - blockStart.ordinal,
      };
    }
    return null;
  };

  const flexibleCjkPattern = buildFlexibleCjkPattern(normalizedQuery);
  if (flexibleCjkPattern) {
    let match: RegExpExecArray | null;
    while ((match = flexibleCjkPattern.exec(normalizedBody)) !== null) {
      const candidate = candidateForMatch(match.index, match.index + match[0].length);
      if (candidate && (!best || candidate.span < best.span)) {
        best = candidate;
      }
    }
  } else {
    let matchStart = normalizedBody.indexOf(normalizedQuery);
    while (matchStart !== -1) {
      const candidate = candidateForMatch(matchStart, matchStart + normalizedQuery.length);
      if (candidate && (!best || candidate.span < best.span)) {
        best = candidate;
      }
      matchStart = normalizedBody.indexOf(normalizedQuery, matchStart + 1);
    }
  }

  return best ? { blockStart: best.blockStart, blockEnd: best.blockEnd } : null;
}
