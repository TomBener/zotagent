import type { AttachmentManifest } from "./types.js";

export function normalizeExactText(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
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

export function findExactPhraseBlockRange(
  manifest: AttachmentManifest,
  query: string,
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
  let matchStart = normalizedBody.indexOf(normalizedQuery);

  while (matchStart !== -1) {
    const matchEnd = matchStart + normalizedQuery.length - 1;
    const blockStart = findBlockForOffset(matchStart);
    const blockEnd = findBlockForOffset(matchEnd);

    if (blockStart !== null && blockEnd !== null) {
      const candidate = {
        blockStart: blockStart.blockIndex,
        blockEnd: blockEnd.blockIndex,
        span: blockEnd.ordinal - blockStart.ordinal,
      };
      if (!best || candidate.span < best.span) {
        best = candidate;
      }
    }

    matchStart = normalizedBody.indexOf(normalizedQuery, matchStart + 1);
  }

  return best ? { blockStart: best.blockStart, blockEnd: best.blockEnd } : null;
}
