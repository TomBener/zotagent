import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { getDataPaths } from "./config.js";
import { normalizeExactText } from "./exact.js";
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

/** Use ripgrep to find candidate files, then do precise matching only on hits. */
function rgCandidates(query: string, dir: string): Set<string> | null {
  try {
    const stdout = execFileSync("rg", ["-il", "--no-messages", "--glob", "*.md", query, dir], {
      encoding: "utf-8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const docKeys = new Set<string>();
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const name = basename(line);
      if (name.endsWith(".md")) {
        docKeys.add(name.slice(0, -3));
      }
    }
    return docKeys;
  } catch (error: unknown) {
    // rg exits 1 when no matches found — that's a valid empty result.
    if (error && typeof error === "object" && "status" in error && error.status === 1) {
      return new Set<string>();
    }
    // rg not installed or other error — fall back to full scan.
    return null;
  }
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

      // Try ripgrep for fast pre-filtering; fall back to full scan if unavailable.
      const rgHits = rgCandidates(query, normalizedDir);
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

        // When rg was not available, do a quick pre-filter.
        if (rgHits === null && !content.toLowerCase().includes(query.toLowerCase())) continue;

        const normalized = normalizeExactText(content);
        let count = 0;
        let pos = normalized.indexOf(normalizedQuery);
        while (pos !== -1) {
          count++;
          pos = normalized.indexOf(normalizedQuery, pos + 1);
        }

        if (count > 0) {
          results.push({ docKey, score: count });
        }

        if (results.length >= limit * 10) break;
      }

      results.sort((a, b) => b.score - a.score);
      return results.slice(0, limit);
    },

    close: async () => {},
  };
}
