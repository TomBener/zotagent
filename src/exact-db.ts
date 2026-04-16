import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { getDataPaths } from "./config.js";
import { countExactMatches, normalizeExactText } from "./exact.js";
import type { AppConfig } from "./types.js";

export interface ExactSearchCandidate {
  docKey: string;
  score: number;
}

export interface ExactIndexClient {
  searchExactCandidates(query: string, limit: number): Promise<ExactSearchCandidate[]>;
  close(): Promise<void>;
}

export type ExactIndexFactory = (config: AppConfig) => Promise<ExactIndexClient>;

function docKeysFromRgOutput(stdout: string): Set<string> {
  const docKeys = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const name = basename(line);
    if (name.endsWith(".md")) {
      docKeys.add(name.slice(0, -3));
    }
  }
  return docKeys;
}

function expandAsciiTokenVariants(token: string): string[] {
  const variants = [token];
  if (!/[0-9a-z]/u.test(token)) {
    return variants;
  }

  const fullWidth = token.replace(/[0-9a-z]/gu, (char) =>
    String.fromCodePoint(char.codePointAt(0)! + 0xFEE0)
  );
  if (fullWidth !== token) {
    variants.push(fullWidth);
  }

  return variants;
}

function rgTokenCandidates(token: string, dir: string): Set<string> | null {
  try {
    const stdout = execFileSync(
      "rg",
      [
        "-il",
        "--ignore-case",
        "--fixed-strings",
        "--no-messages",
        "--glob",
        "*.md",
        ...expandAsciiTokenVariants(token).flatMap((variant) => ["-e", variant]),
        dir,
      ],
      {
        encoding: "utf-8",
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return docKeysFromRgOutput(stdout);
  } catch (error: unknown) {
    // rg exits 1 when no matches found — that's a valid empty result.
    if (error && typeof error === "object" && "status" in error && error.status === 1) {
      return new Set<string>();
    }
    // rg not installed or other error — fall back to full scan.
    return null;
  }
}

function intersectDocKeys(left: Set<string>, right: Set<string>): Set<string> {
  const intersection = new Set<string>();
  for (const docKey of left) {
    if (right.has(docKey)) {
      intersection.add(docKey);
    }
  }
  return intersection;
}

const MAX_CANDIDATES = 100;

/** Try full phrase first (fast, narrow), then merge with per-token intersection for normalization mismatches. */
function rgCandidates(normalizedQuery: string, dir: string): Set<string> | null {
  // 1. Try the full phrase — this is the fast path for most queries.
  const phraseHits = rgTokenCandidates(normalizedQuery, dir);
  if (phraseHits === null) return null; // rg not available

  // 2. When the phrase matched, return immediately — this keeps search fast.
  //    The token fallback only runs when the exact phrase is absent from all files,
  //    catching cases like line breaks inside the phrase.
  if (phraseHits.size > 0) return phraseHits;

  const tokens = normalizedQuery.split(" ").filter((t) => t.length > 0);
  if (tokens.length <= 1) return phraseHits;

  // Sort tokens by descending length so the rarest (longest) token runs first,
  // producing the smallest initial candidate set.
  const sorted = [...tokens].sort((a, b) => b.length - a.length);

  let candidates: Set<string> | null = null;
  for (const token of sorted) {
    const tokenCandidates = rgTokenCandidates(token, dir);
    if (tokenCandidates === null) return null;
    candidates = candidates === null ? tokenCandidates : intersectDocKeys(candidates, tokenCandidates);
    if (candidates.size === 0) return candidates;
  }

  // Merge phrase hits (always included) with token-intersection candidates.
  const merged = new Set(phraseHits);
  if (candidates) {
    for (const docKey of candidates) merged.add(docKey);
  }

  // Cap to avoid slow normalizeExactText on too many files.
  // Phrase hits are already in the set so they're always retained.
  if (merged.size > MAX_CANDIDATES) {
    const capped = new Set<string>();
    // Ensure phrase hits are always included.
    for (const docKey of phraseHits) capped.add(docKey);
    for (const docKey of merged) {
      if (capped.size >= MAX_CANDIDATES) break;
      capped.add(docKey);
    }
    return capped;
  }

  return merged;
}

function scanAllFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

export async function openExactIndex(config: AppConfig): Promise<ExactIndexClient> {
  const paths = getDataPaths(config.dataDir);
  const normalizedDir = paths.normalizedDir;

  return {
    searchExactCandidates: async (query, limit) => {
      const normalizedQuery = normalizeExactText(query);
      if (normalizedQuery.length === 0) {
        throw new Error("Exact search text cannot be empty.");
      }

      // Try ripgrep for fast token pre-filtering; fall back to full scan if unavailable.
      const rgHits = rgCandidates(normalizedQuery, normalizedDir);
      const filenames = rgHits !== null
        ? [...rgHits].map((docKey) => `${docKey}.md`)
        : scanAllFiles(normalizedDir);

      const results: ExactSearchCandidate[] = [];

      for (const filename of filenames) {
        const docKey = filename.slice(0, -3);
        const filePath = resolve(normalizedDir, filename);
        let content: string;
        try {
          content = readFileSync(filePath, "utf-8");
        } catch {
          continue;
        }

        const normalized = normalizeExactText(content);
        const count = countExactMatches(normalized, normalizedQuery);

        if (count > 0) {
          results.push({ docKey, score: count });
        }
      }

      results.sort((a, b) => (b.score - a.score) || a.docKey.localeCompare(b.docKey));
      return results.slice(0, limit);
    },

    close: async () => {},
  };
}
