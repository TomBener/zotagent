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

export function findExactPhraseBlockRange(
  manifest: AttachmentManifest,
  query: string,
): { blockStart: number; blockEnd: number } | null {
  const normalizedQuery = normalizeExactText(query);
  if (normalizedQuery.length === 0) return null;

  const normalizedBlocks = manifest.blocks.map((block) => ({
    blockIndex: block.blockIndex,
    text: normalizeExactText(block.text),
  }));

  let best: { blockStart: number; blockEnd: number; span: number } | null = null;

  for (let start = 0; start < normalizedBlocks.length; start++) {
    let combined = "";
    for (let end = start; end < normalizedBlocks.length; end++) {
      const text = normalizedBlocks[end]!.text;
      combined = combined.length > 0 ? `${combined} ${text}`.trim() : text;
      if (combined.length === 0) continue;
      if (!combined.includes(normalizedQuery)) continue;

      const candidate = {
        blockStart: normalizedBlocks[start]!.blockIndex,
        blockEnd: normalizedBlocks[end]!.blockIndex,
        span: end - start,
      };
      if (!best || candidate.span < best.span) {
        best = candidate;
      }
      break;
    }
  }

  return best ? { blockStart: best.blockStart, blockEnd: best.blockEnd } : null;
}
