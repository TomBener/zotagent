#!/usr/bin/env node

import { getDataPaths, resolveConfig, type ConfigOverrides } from "./config.js";
import { expandDocument, getIndexStatus, readDocument, searchLiterature } from "./engine.js";
import { emitError, emitOk } from "./json.js";
import { openQmdClient } from "./qmd.js";
import { runSync } from "./sync.js";
import { compactHomePath } from "./utils.js";
import { readFileSync } from "node:fs";

type FlagValue = string | boolean;

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, FlagValue>;
}

const BOOLEAN_FLAGS = new Set(["exact", "help", "no-rerank", "rerank", "version"]);

function getCliVersion(): string {
  const packageJsonPath = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version: string };
  return packageJson.version;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, FlagValue> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const trimmed = token.slice(2);
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex >= 0) {
      flags[trimmed.slice(0, eqIndex)] = trimmed.slice(eqIndex + 1);
      continue;
    }
    if (BOOLEAN_FLAGS.has(trimmed)) {
      flags[trimmed] = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags[trimmed] = true;
      continue;
    }
    flags[trimmed] = next;
    i++;
  }
  return { positionals, flags };
}

function getStringFlag(flags: Record<string, FlagValue>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = flags[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function getNumberFlag(flags: Record<string, FlagValue>, ...keys: string[]): number | undefined {
  const raw = getStringFlag(flags, ...keys);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return value;
}

function getBooleanFlag(flags: Record<string, FlagValue>, key: string): boolean {
  return flags[key] === true;
}

function overridesFromFlags(flags: Record<string, FlagValue>): ConfigOverrides {
  return {
    bibliographyJsonPath: getStringFlag(flags, "bibliography", "bibliography-json"),
    attachmentsRoot: getStringFlag(flags, "attachments-root"),
    dataDir: getStringFlag(flags, "data-dir"),
    qmdEmbedModel: getStringFlag(flags, "qmd-embed-model"),
    embeddingProvider: getStringFlag(flags, "embedding-provider"),
    embeddingModel: getStringFlag(flags, "embedding-model"),
    googleApiKey: getStringFlag(flags, "google-api-key"),
  };
}

function printHelp(): void {
  console.log(`zotlit

Search indexed Zotero PDFs and follow hits with read or expand.

Usage:
  zotlit sync [--attachments-root <path>]
  zotlit status
  zotlit version
  zotlit search "<text>" [--exact] [--limit <n>] [--min-score <n>] [--rerank|--no-rerank]
  zotlit read (--file <path> | --item-key <key>) [--offset-block <n>] [--limit-blocks <n>]
  zotlit expand --file <path> --block-start <n> [--block-end <n>] [--radius <n>]

Commands:
  sync
    Refresh the local index.
    Use --attachments-root to index only a Zotero subfolder.

  status
    Show attachment counts, local index paths, and qmd status.

  version
    Print the current zotlit version.

  search
    Search indexed Zotero PDFs.
    --exact uses exact phrase search.
    --rerank / --no-rerank override qmd's default rerank behavior.
    --exact cannot be combined with --rerank.

  read
    Read blocks directly from a local manifest.
    Use either --file or --item-key.

  expand
    Expand around a search hit or block range from a local manifest.
    expand currently requires --file.

Options:
  --attachments-root <path>   Limit sync to a Zotero subfolder.
  --exact                     Use exact phrase search for search.
  --limit <n>                 Return up to n search results. Default: 10.
  --min-score <n>             Drop lower-scoring search hits before mapping.
  --rerank                    Force reranking for search.
  --no-rerank                 Skip reranking for search.
  --offset-block <n>          Start reading at block n. Default: 0.
  --limit-blocks <n>          Read up to n blocks. Default: 20.
  --block-start <n>           Start block for expand.
  --block-end <n>             End block for expand. Default: block-start.
  --radius <n>                Include n blocks before and after. Default: 2.
  --version                   Print the current zotlit version.

Examples:
  zotlit search "dangwei shuji" --exact
  zotlit search "state-owned enterprise governance" --limit 5 --min-score 0.4
  zotlit expand --file "~/Library/.../paper.pdf" --block-start 10 --radius 2
  zotlit read --item-key KG326EEI
  zotlit status
  zotlit version
  zotlit sync --attachments-root "/path/to/zotero/subfolder"

Config:
  Paths and other defaults are read from ~/.zotlit/config.json.
`);
}

function compactPathMap(paths: ReturnType<typeof getDataPaths>): ReturnType<typeof getDataPaths> {
  return {
    normalizedDir: compactHomePath(paths.normalizedDir),
    manifestsDir: compactHomePath(paths.manifestsDir),
    indexDir: compactHomePath(paths.indexDir),
    tempDir: compactHomePath(paths.tempDir),
    qmdDbPath: compactHomePath(paths.qmdDbPath),
    catalogPath: compactHomePath(paths.catalogPath),
  };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const parsed = parseArgs(process.argv.slice(2));
  const [command] = parsed.positionals;
  const overrides = overridesFromFlags(parsed.flags);

  if (!command && getBooleanFlag(parsed.flags, "version")) {
    console.log(getCliVersion());
    process.exit(0);
  }

  if (!command || command === "help" || command === "--help") {
    printHelp();
    process.exit(0);
  }

  try {
    switch (command) {
      case "sync": {
        if (parsed.positionals.length > 1) {
          emitError(
            "UNEXPECTED_ARGUMENT",
            'sync does not accept a positional path. Use --attachments-root "<path>" instead.',
          );
          return;
        }
        const result = await runSync(overrides);
        emitOk(
          {
            ...result.stats,
            warnings: result.config.warnings,
            paths: compactPathMap(getDataPaths(result.config.dataDir)),
          },
          { elapsedMs: Date.now() - startedAt },
        );
        return;
      }

      case "status": {
        const status = await getIndexStatus(overrides);
        emitOk(
          {
            ...status,
            paths: compactPathMap(status.paths),
          },
          { elapsedMs: Date.now() - startedAt },
        );
        return;
      }

      case "version": {
        if (parsed.positionals.length > 1) {
          emitError("UNEXPECTED_ARGUMENT", "version does not accept additional arguments.");
          return;
        }
        console.log(getCliVersion());
        return;
      }

      case "search": {
        if ("query" in parsed.flags) {
          emitError("UNEXPECTED_ARGUMENT", '`--query` has been removed. Use: zotlit search "<text>"');
          return;
        }
        const query = parsed.positionals.slice(1).join(" ");
        if (!query) {
          emitError("MISSING_ARGUMENT", 'Missing search text. Use: zotlit search "<text>"');
          return;
        }
        const limit = getNumberFlag(parsed.flags, "limit") || 10;
        const exact = getBooleanFlag(parsed.flags, "exact");
        const explicitRerank = getBooleanFlag(parsed.flags, "rerank")
          ? true
          : getBooleanFlag(parsed.flags, "no-rerank")
            ? false
            : undefined;
        if (exact && explicitRerank === true) {
          emitError("UNEXPECTED_ARGUMENT", '`--exact` cannot be combined with `--rerank`.');
          return;
        }
        const minScore = getNumberFlag(parsed.flags, "min-score");
        const data = await searchLiterature(query, limit, overrides, openQmdClient, {
          ...(exact ? { exact: true } : {}),
          ...(explicitRerank !== undefined ? { rerank: explicitRerank } : {}),
          ...(minScore !== undefined ? { minScore } : {}),
        });
        emitOk(data);
        return;
      }

      case "read": {
        const file = getStringFlag(parsed.flags, "file");
        const itemKey = getStringFlag(parsed.flags, "item-key");
        if (!file && !itemKey) {
          emitError("MISSING_ARGUMENT", "Provide either --file <path> or --item-key <key>.");
          return;
        }
        try {
          const data = readDocument(
            {
              file,
              itemKey,
              offsetBlock: getNumberFlag(parsed.flags, "offset-block") || 0,
              limitBlocks: getNumberFlag(parsed.flags, "limit-blocks") || 20,
            },
            overrides,
          );
          emitOk(data, { elapsedMs: Date.now() - startedAt });
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          try {
            const parsedError = JSON.parse(message) as { message?: string; files?: string[] };
            emitError(
              "READ_CONFLICT",
              parsedError.message || message,
              parsedError.files ? { files: parsedError.files } : undefined,
            );
            return;
          } catch {
            emitError("READ_FAILED", message);
            return;
          }
        }
      }

      case "expand": {
        const file = getStringFlag(parsed.flags, "file");
        const blockStart = getNumberFlag(parsed.flags, "block-start");
        const blockEnd = getNumberFlag(parsed.flags, "block-end") ?? blockStart;
        if (!file || blockStart === undefined) {
          emitError(
            "MISSING_ARGUMENT",
            "Provide --file <path> and --block-start <n> for expand.",
          );
          return;
        }
        const data = expandDocument(
          {
            file,
            blockStart,
            blockEnd: blockEnd!,
            radius: getNumberFlag(parsed.flags, "radius") || 2,
          },
          overrides,
        );
        emitOk(data, { elapsedMs: Date.now() - startedAt });
        return;
      }

      default:
        emitError("UNKNOWN_COMMAND", `Unknown command: ${command}`);
        return;
    }
  } catch (error) {
    emitError(
      "UNEXPECTED_ERROR",
      error instanceof Error ? error.message : String(error),
      undefined,
      { elapsedMs: Date.now() - startedAt },
    );
    return;
  }
}

void main();
