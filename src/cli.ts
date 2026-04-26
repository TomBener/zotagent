#!/usr/bin/env node

import { readFileSync } from "node:fs";

import {
  addJsonItemsToZotero,
  addS2PaperToZotero,
  addToZotero,
  type AddJsonItemFailure,
  type AddJsonItemResult,
} from "./add.js";
import { ConfigCommandError, runConfigCommand } from "./config-command.js";
import { getDataPaths, resolveConfig, type ConfigOverrides } from "./config.js";
import { expandDocument, fullTextDocument, getDocumentBlocks, getIndexStatus, searchLiterature, searchWithinDocuments } from "./engine.js";
import { emitError, emitOk } from "./json.js";
import { JsonInputError, mapLenientItem, readJsonInput, type AddJsonInput } from "./json-input.js";
import { KeywordQuerySyntaxError } from "./keyword-db.js";
import { searchMetadata } from "./metadata.js";
import { openQmdClient } from "./qmd.js";
import { listRecentItems, type RecentSort } from "./recent.js";
import { searchSemanticScholar } from "./s2.js";
import { runSync } from "./sync.js";
import type { MetadataField } from "./types.js";
import { compactHomePath } from "./utils.js";

type FlagValue = string | string[] | boolean;

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, FlagValue>;
}

const BOOLEAN_FLAGS = new Set([
  "abstract",
  "clean",
  "has-file",
  "help",
  "keyword",
  "retry-errors",
  "semantic",
  "version",
]);
const METADATA_FIELDS: MetadataField[] = ["title", "author", "year", "abstract", "journal", "publisher"];

// Every known command declares exactly which command-specific flags it accepts.
// Global config overrides (GLOBAL_OVERRIDE_FLAGS) are always permitted on top.
// Anything else triggers UNEXPECTED_ARGUMENT rather than being silently ignored.
const COMMAND_FLAG_ALLOWLIST: Record<string, ReadonlyArray<string>> = {
  sync: ["attachments-root", "retry-errors", "pdf-timeout-ms", "pdf-batch-size", "pdf-concurrency"],
  status: [],
  config: [],
  version: [],
  help: [],
  add: [
    "doi",
    "s2-paper-id",
    "json",
    "title",
    "author",
    "year",
    "publication",
    "url",
    "url-date",
    "access-date",
    "collection-key",
    "item-type",
  ],
  s2: ["limit"],
  recent: ["limit", "sort"],
  search: ["keyword", "semantic", "limit", "min-score"],
  "search-in": ["key", "limit"],
  metadata: ["limit", "field", "has-file", "abstract", "author", "year", "title", "journal", "publisher"],
  blocks: ["key", "offset-block", "limit-blocks"],
  fulltext: ["key", "clean"],
  expand: ["key", "block-start", "block-end", "radius"],
};

const GLOBAL_OVERRIDE_FLAGS: ReadonlyArray<string> = [
  "bibliography",
  "bibliography-json",
  "attachments-root",
  "data-dir",
  "qmd-embed-model",
  "semantic-scholar-api-key",
  "zotero-library-id",
  "zotero-library-type",
  "zotero-collection-key",
  "zotero-api-key",
  "embedding-provider",
  "embedding-model",
  "google-api-key",
];

function rejectUnknownFlags(command: string, flags: Record<string, FlagValue>): string | undefined {
  const commandAllowlist = COMMAND_FLAG_ALLOWLIST[command];
  if (commandAllowlist === undefined) return undefined;
  const allowed = new Set<string>([...commandAllowlist, ...GLOBAL_OVERRIDE_FLAGS]);
  const unknown = Object.keys(flags).filter((flag) => !allowed.has(flag)).sort();
  if (unknown.length === 0) return undefined;
  const unknownList = unknown.map((flag) => `--${flag}`).join(", ");
  if (commandAllowlist.length === 0) {
    return `${command} does not accept any command-specific flags. Remove: ${unknownList}`;
  }
  const validList = commandAllowlist.map((flag) => `--${flag}`).join(", ");
  return `${command} only supports ${validList}. Remove: ${unknownList}`;
}

function getCliVersion(): string {
  const packageJsonPath = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version: string };
  return packageJson.version;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, FlagValue> = {};

  const assignFlag = (key: string, value: string | boolean): void => {
    const existing = flags[key];
    if (typeof value === "boolean") {
      flags[key] = value;
      return;
    }
    if (existing === undefined || typeof existing === "boolean") {
      flags[key] = value;
      return;
    }
    if (typeof existing === "string") {
      flags[key] = [existing, value];
      return;
    }
    flags[key] = [...existing, value];
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const trimmed = token.slice(2);
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex >= 0) {
      assignFlag(trimmed.slice(0, eqIndex), trimmed.slice(eqIndex + 1));
      continue;
    }
    if (BOOLEAN_FLAGS.has(trimmed)) {
      assignFlag(trimmed, true);
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      assignFlag(trimmed, true);
      continue;
    }
    assignFlag(trimmed, next);
    i++;
  }
  return { positionals, flags };
}

function getStringFlag(flags: Record<string, FlagValue>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = flags[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (Array.isArray(value)) {
      const last = value[value.length - 1];
      if (typeof last === "string" && last.length > 0) return last;
    }
  }
  return undefined;
}

// Strip a leading '@' so agents can pass Pandoc-style @citekey / @itemkey
// directly. CSL JSON stores the bare id, so the '@' is only a draft-syntax
// wrapper and should not reach resolution.
function getKeyFlag(flags: Record<string, FlagValue>): string | undefined {
  const raw = getStringFlag(flags, "key");
  if (!raw) return undefined;
  return raw.startsWith("@") ? raw.slice(1) : raw;
}

function getStringListFlag(flags: Record<string, FlagValue>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = flags[key];
    if (typeof value === "string" && value.length > 0) return [value];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    }
  }
  return [];
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

interface NumericFlagOptions {
  requirement: string;
  constraint: string;
  integer?: boolean;
  min?: number;
}

function parseNumericFlag(
  flags: Record<string, FlagValue>,
  key: string,
  options: NumericFlagOptions,
): { value?: number; error?: string } {
  if (!(key in flags)) return {};
  if (flags[key] === true) {
    return { error: `\`--${key}\` requires ${options.requirement}.` };
  }

  const raw = getStringFlag(flags, key);
  if (!raw) {
    return { error: `\`--${key}\` requires ${options.requirement}.` };
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return { error: `\`--${key}\` must be ${options.constraint}.` };
  }
  if (options.integer && !Number.isInteger(value)) {
    return { error: `\`--${key}\` must be ${options.constraint}.` };
  }
  if (options.min !== undefined && value < options.min) {
    return { error: `\`--${key}\` must be ${options.constraint}.` };
  }
  return { value };
}

function overridesFromFlags(flags: Record<string, FlagValue>): ConfigOverrides {
  return {
    bibliographyJsonPath: getStringFlag(flags, "bibliography", "bibliography-json"),
    attachmentsRoot: getStringFlag(flags, "attachments-root"),
    dataDir: getStringFlag(flags, "data-dir"),
    qmdEmbedModel: getStringFlag(flags, "qmd-embed-model"),
    semanticScholarApiKey: getStringFlag(flags, "semantic-scholar-api-key"),
    zoteroLibraryId: getStringFlag(flags, "zotero-library-id"),
    zoteroLibraryType: getStringFlag(flags, "zotero-library-type"),
    zoteroCollectionKey: getStringFlag(flags, "zotero-collection-key"),
    zoteroApiKey: getStringFlag(flags, "zotero-api-key"),
    embeddingProvider: getStringFlag(flags, "embedding-provider"),
    embeddingModel: getStringFlag(flags, "embedding-model"),
    googleApiKey: getStringFlag(flags, "google-api-key"),
  };
}

function printHelp(): void {
  console.log(`zotagent — Zotero CLI for AI agents.

Usage: zotagent <command> [flags]

All commands emit pretty-printed JSON on stdout. Success payloads are
{ok: true, data, meta?}; failures are {ok: false, error: {code, message, details?},
meta?} with exit code 1. Missing credentials fail fast with a JSON error.

Index
  sync [--attachments-root <path>] [--retry-errors] [--pdf-timeout-ms <n>] [--pdf-batch-size <n>]
       [--pdf-concurrency <n>]
      Build or refresh the local index of PDF, EPUB, HTML, and TXT attachments.
      Unchanged extraction errors are skipped by default; pass --retry-errors to retry them.
        --attachments-root <path>   Index only a Zotero subfolder.
        --retry-errors              Retry unchanged files that failed extraction earlier.
        --pdf-timeout-ms <n>        Override the OpenDataLoader timeout for each PDF extraction call.
        --pdf-batch-size <n>        Override the maximum number of PDFs per extraction batch.
        --pdf-concurrency <n>       Run N extraction batches in parallel (default 2). Each batch
                                    spawns its own java process; tune with available CPU and RAM.

  status
      Show attachment counts, local index paths, and qmd status.

  version, --version            Print the current zotagent version.
  help, --help                  Show this help. Also shown when no command is given.

  config
      Interactively set ~/.zotagent/config.json.

Search
  search "<text>" [--keyword | --semantic] [--limit <n>] [--min-score <n>]
      Search indexed documents. Pass at most one of --keyword (default) or --semantic.
      Default is keyword search (FTS5 with porter stemming): "exact phrase", OR, NOT,
      term NEAR/<n> term, prefix*. Use NEAR/50 for proximity; NEAR(...) is not accepted.
      Chinese, Japanese, and Korean text is supported with accurate phrase matching.
      --semantic uses qmd vector search with LLM query expansion (slower, heavier).
        --limit <n>                 Return up to n search results. Default: 10 for search, 20 for metadata.
        --min-score <n>             Drop lower-scoring search hits before mapping.

  search-in "<text>" --key <key> [--limit <n>]
      Search within one indexed item's attachments (exact phrase and term match).

  metadata ["<text>"] [--limit <n>] [--field <field>] [--has-file] [--abstract]
           [--author <text>] [--year <text>] [--title <text>] [--journal <text>] [--publisher <text>]
      Search Zotero bibliography metadata read from bibliographyJsonPath.
      Provide a positional query, one or more field filters, or both. The
      positional query is substring-matched across --field selections; each
      filter flag adds an AND constraint on that specific field.
        --field <field>             Limit the positional query to title, author, year, abstract,
                                    journal, or publisher. Repeatable.
        --author <text>             Filter by author substring.
        --year <text>               Filter by year substring (e.g. "1985", "198" for the 80s).
        --title <text>              Filter by title substring.
        --journal <text>            Filter by journal substring.
        --publisher <text>          Filter by publisher substring.
        --has-file                  Keep only metadata results with a supported indexed attachment.
        --abstract                  Include the abstract in each result. Omitted by default to keep
                                    bulk responses compact for agents.

Retrieval
  blocks --key <key> [--offset-block <n>] [--limit-blocks <n>]
      Return paginated blocks from one indexed item.
      When one item has multiple indexed attachments, they are merged into one logical
      document with monotonic block indices and "# Attachment: <name>" dividers between them.
        --offset-block <n>          Start at block n. Default: 0.
        --limit-blocks <n>          Return up to n blocks. Default: 20.

  fulltext --key <key> [--clean]
      Output agent-friendly full text for one item. Multi-attachment items return one
      merged markdown document.
        --clean                     Apply heuristic cleanup (drops duplicate blocks and
                                    common boilerplate such as citation notices and TOC lines).

  expand --key <key> --block-start <n> [--block-end <n>] [--radius <n>]
      Expand around a search hit or block range from a local manifest.
      Block indices are item-global; feed blockStart from search results directly.
        --block-start <n>           Start block for expand.
        --block-end <n>             End block for expand. Default: block-start.
        --radius <n>                Include n blocks before and after. Default: 2.

Document selector (used by search-in, blocks, fulltext, expand)
  --key <key>                   Resolve an item by itemKey or citationKey. A leading @ is
                                stripped before dispatch; values matching [A-Z0-9]{8} are
                                itemKey, anything else is citationKey. Output always
                                identifies items by itemKey only.

Add to Zotero
  add [--doi <doi> | --s2-paper-id <id> | --json <file|->] [--title <text>] [--author <name>]
      [--year <text>] [--publication <text>] [--url <url>] [--url-date <date>]
      [--collection-key <key>] [--item-type <type>]
      Create one or many Zotero items and return their itemKeys. Prefer --doi when available.
      --s2-paper-id imports from Semantic Scholar (and still prefers DOI when present).
      --json reads pre-shaped JSON metadata from a file or stdin and is best for batch
      ingest from sources without working DOIs (e.g. CNKI). The JSON form is mutually
      exclusive with all other input flags except --collection-key.
        --doi <doi>                 Import from DOI metadata when possible.
        --s2-paper-id <id>          Import a Semantic Scholar paper by paperId.
        --json <file|->             Read one JSON object or an array of JSON objects from
                                    a file or stdin (use '-'). Lenient Zotero schema:
                                    accepts authors[]/keywords[]/abstract/doi aliases plus
                                    direct Zotero field names. Always returns data: AddResult[].
        --title <text>              Set title for manual add or DOI fallback.
        --author <name>             Add an author. Repeat for multiple authors.
        --year <text>               Set the Zotero date field.
        --publication <text>        Set journal, website, or container title when supported.
        --url <url>                 Set the item URL.
        --url-date <date>           Set the access date for the URL. Alias: --access-date.
        --collection-key <key>      Add the new item(s) to a Zotero collection by collection key.
                                    With --json this overrides any per-item collections field.
        --item-type <type>          Override the Zotero item type. Default: journalArticle or webpage.

  s2 "<text>" [--limit <n>]
      Search Semantic Scholar; pass a returned paperId to \`add --s2-paper-id\`.

  recent [--limit <n>] [--sort added|modified]
      List regular top-level Zotero items most recently added or modified.
      Fetches live from the Zotero Web API; does not require a sync. Skips
      standalone notes and attachments. Returns itemKey plus title, authors,
      year, type, dateAdded, and dateModified.
        --limit <n>                 Return up to n items. Default: 10. Max: 100.
        --sort added|modified       Sort by dateAdded (default) or dateModified.
`);
}

function compactPathMap(paths: ReturnType<typeof getDataPaths>): ReturnType<typeof getDataPaths> {
  return {
    logsDir: compactHomePath(paths.logsDir),
    latestSyncLogPath: compactHomePath(paths.latestSyncLogPath),
    normalizedDir: compactHomePath(paths.normalizedDir),
    manifestsDir: compactHomePath(paths.manifestsDir),
    indexDir: compactHomePath(paths.indexDir),
    keywordDbPath: compactHomePath(paths.keywordDbPath),
    tempDir: compactHomePath(paths.tempDir),
    qmdDbPath: compactHomePath(paths.qmdDbPath),
    catalogPath: compactHomePath(paths.catalogPath),
  };
}

function emitDocumentLookupError(prefix: "SEARCH_IN" | "BLOCKS" | "FULLTEXT" | "EXPAND", error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  emitError(`${prefix}_FAILED`, message);
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
    const flagError = rejectUnknownFlags(command, parsed.flags);
    if (flagError) {
      emitError("UNEXPECTED_ARGUMENT", flagError);
      return;
    }
    switch (command) {
      case "sync": {
        if (parsed.positionals.length > 1) {
          emitError(
            "UNEXPECTED_ARGUMENT",
            'sync does not accept a positional path. Use --attachments-root "<path>" instead.',
          );
          return;
        }
        if (parsed.flags["pdf-timeout-ms"] === true) {
          emitError("INVALID_ARGUMENT", "`--pdf-timeout-ms` requires a positive number.");
          return;
        }
        if (parsed.flags["pdf-batch-size"] === true) {
          emitError("INVALID_ARGUMENT", "`--pdf-batch-size` requires a positive number.");
          return;
        }
        if (parsed.flags["pdf-concurrency"] === true) {
          emitError("INVALID_ARGUMENT", "`--pdf-concurrency` requires a positive number.");
          return;
        }
        const pdfTimeoutMs = getNumberFlag(parsed.flags, "pdf-timeout-ms");
        if (pdfTimeoutMs !== undefined && (!Number.isInteger(pdfTimeoutMs) || pdfTimeoutMs <= 0)) {
          emitError("INVALID_ARGUMENT", "`--pdf-timeout-ms` must be a positive integer.");
          return;
        }
        const pdfBatchSize = getNumberFlag(parsed.flags, "pdf-batch-size");
        if (pdfBatchSize !== undefined && (!Number.isInteger(pdfBatchSize) || pdfBatchSize <= 0)) {
          emitError("INVALID_ARGUMENT", "`--pdf-batch-size` must be a positive integer.");
          return;
        }
        const pdfConcurrency = getNumberFlag(parsed.flags, "pdf-concurrency");
        if (pdfConcurrency !== undefined && (!Number.isInteger(pdfConcurrency) || pdfConcurrency <= 0)) {
          emitError("INVALID_ARGUMENT", "`--pdf-concurrency` must be a positive integer.");
          return;
        }
        const syncConfig = resolveConfig(overrides);
        if (syncConfig.syncEnabled === false) {
          emitError(
            "SYNC_DISABLED",
            "sync is disabled on this host. Set `syncEnabled` to true in ~/.zotagent/config.json (or ZOTAGENT_SYNC_ENABLED=true) to enable.",
          );
          return;
        }
        const result = await runSync(overrides, openQmdClient, undefined, undefined, undefined, {
          ...(getBooleanFlag(parsed.flags, "retry-errors") ? { retryErrors: true } : {}),
          ...(pdfTimeoutMs !== undefined ? { pdfTimeoutMs } : {}),
          ...(pdfBatchSize !== undefined ? { pdfBatchSize } : {}),
          ...(pdfConcurrency !== undefined ? { pdfConcurrency } : {}),
        });
        emitOk(
          {
            ...result.stats,
            logPath: compactHomePath(result.logPath),
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

      case "config": {
        if (parsed.positionals.length > 1) {
          emitError("UNEXPECTED_ARGUMENT", "config does not accept positional arguments.");
          return;
        }
        try {
          const result = await runConfigCommand();
          emitOk(
            {
              ...result,
              path: compactHomePath(result.path),
            },
            { elapsedMs: Date.now() - startedAt },
          );
          return;
        } catch (error) {
          if (error instanceof ConfigCommandError) {
            emitError(error.code, error.message, undefined, { elapsedMs: Date.now() - startedAt });
            return;
          }
          throw error;
        }
      }

      case "version": {
        if (parsed.positionals.length > 1) {
          emitError("UNEXPECTED_ARGUMENT", "version does not accept additional arguments.");
          return;
        }
        console.log(getCliVersion());
        return;
      }

      case "add": {
        if (parsed.positionals.length > 1) {
          emitError("UNEXPECTED_ARGUMENT", "add does not accept positional arguments. Use flags such as --doi or --title.");
          return;
        }
        const missingValueFlags = [
          "doi",
          "s2-paper-id",
          "json",
          "title",
          "author",
          "year",
          "publication",
          "url",
          "url-date",
          "access-date",
          "collection-key",
          "item-type",
        ].filter((flag) => parsed.flags[flag] === true);
        if (missingValueFlags.length > 0) {
          emitError(
            "INVALID_ARGUMENT",
            `Missing value for: ${missingValueFlags.map((flag) => `--${flag}`).join(", ")}`,
          );
          return;
        }
        const jsonSource = getStringFlag(parsed.flags, "json");
        if (jsonSource) {
          const conflicting = [
            "doi",
            "s2-paper-id",
            "title",
            "author",
            "year",
            "publication",
            "url",
            "url-date",
            "access-date",
            "item-type",
          ].filter((flag) => flag in parsed.flags);
          if (conflicting.length > 0) {
            emitError(
              "UNEXPECTED_ARGUMENT",
              `--json mode accepts only --collection-key alongside it. Remove: ${conflicting
                .map((flag) => `--${flag}`)
                .join(", ")}`,
            );
            return;
          }
          try {
            const bundle = await readJsonInput(jsonSource);
            type Stage =
              | { kind: "ready"; input: AddJsonInput }
              | { kind: "failed"; failure: AddJsonItemFailure };
            const stages: Stage[] = [];
            for (const raw of bundle.items) {
              try {
                stages.push({ kind: "ready", input: mapLenientItem(raw) });
              } catch (mapError) {
                if (mapError instanceof JsonInputError) {
                  stages.push({
                    kind: "failed",
                    failure: {
                      ok: false,
                      error: { code: "INVALID_INPUT", message: mapError.message },
                    },
                  });
                  continue;
                }
                throw mapError;
              }
            }
            const readyInputs = stages
              .filter((s): s is Extract<Stage, { kind: "ready" }> => s.kind === "ready")
              .map((s) => s.input);
            const cliCollectionKey = getStringFlag(parsed.flags, "collection-key");
            const successResults = await addJsonItemsToZotero(
              readyInputs,
              overrides,
              cliCollectionKey,
            );
            let resultCursor = 0;
            const merged: AddJsonItemResult[] = stages.map((stage) =>
              stage.kind === "ready" ? successResults[resultCursor++] : stage.failure,
            );
            emitOk(merged, { elapsedMs: Date.now() - startedAt });
          } catch (error) {
            if (error instanceof JsonInputError) {
              emitError("INVALID_ARGUMENT", error.message, error.details, {
                elapsedMs: Date.now() - startedAt,
              });
              return;
            }
            const message = error instanceof Error ? error.message : String(error);
            emitError("ADD_JSON_FAILED", message, undefined, {
              elapsedMs: Date.now() - startedAt,
            });
          }
          return;
        }
        const doi = getStringFlag(parsed.flags, "doi");
        const s2PaperId = getStringFlag(parsed.flags, "s2-paper-id");
        const title = getStringFlag(parsed.flags, "title");
        if (doi && s2PaperId) {
          emitError("UNEXPECTED_ARGUMENT", "Use either --doi <doi> or --s2-paper-id <id>, not both.");
          return;
        }
        if (!doi && !s2PaperId && !title) {
          emitError("MISSING_ARGUMENT", "Provide --doi <doi>, --s2-paper-id <id>, --json <file|->, or --title <text> for add.");
          return;
        }
        const authors = getStringListFlag(parsed.flags, "author");
        const sharedInput = {
          ...(doi ? { doi } : {}),
          ...(title ? { title } : {}),
          ...(authors.length > 0 ? { authors } : {}),
          ...(getStringFlag(parsed.flags, "year") ? { year: getStringFlag(parsed.flags, "year")! } : {}),
          ...(getStringFlag(parsed.flags, "publication")
            ? { publication: getStringFlag(parsed.flags, "publication")! }
            : {}),
          ...(getStringFlag(parsed.flags, "url") ? { url: getStringFlag(parsed.flags, "url")! } : {}),
          ...(getStringFlag(parsed.flags, "url-date", "access-date")
            ? { urlDate: getStringFlag(parsed.flags, "url-date", "access-date")! }
            : {}),
          ...(getStringFlag(parsed.flags, "collection-key")
            ? { collectionKey: getStringFlag(parsed.flags, "collection-key")! }
            : {}),
          ...(getStringFlag(parsed.flags, "item-type")
            ? { itemType: getStringFlag(parsed.flags, "item-type")! }
            : {}),
        };
        const data = s2PaperId
          ? await addS2PaperToZotero(s2PaperId, sharedInput, overrides)
          : await addToZotero(sharedInput, overrides);
        emitOk(data, { elapsedMs: Date.now() - startedAt });
        return;
      }

      case "recent": {
        if (parsed.positionals.length > 1) {
          emitError("UNEXPECTED_ARGUMENT", "recent does not accept positional arguments.");
          return;
        }
        const limitInput = parseNumericFlag(parsed.flags, "limit", {
          requirement: "a positive integer",
          constraint: "a positive integer between 1 and 100",
          integer: true,
          min: 1,
        });
        if (limitInput.error) {
          emitError("INVALID_ARGUMENT", limitInput.error);
          return;
        }
        const limit = limitInput.value ?? 10;
        if (limit > 100) {
          emitError("INVALID_ARGUMENT", "`--limit` for recent cannot exceed 100 (Zotero API page size).");
          return;
        }
        if (parsed.flags.sort === true) {
          emitError("INVALID_ARGUMENT", "`--sort` requires a value: `added` or `modified`.");
          return;
        }
        const sortRaw = getStringFlag(parsed.flags, "sort") ?? "added";
        let sort: RecentSort;
        if (sortRaw === "added") sort = "dateAdded";
        else if (sortRaw === "modified") sort = "dateModified";
        else {
          emitError("INVALID_ARGUMENT", "`--sort` must be `added` or `modified`.");
          return;
        }
        const data = await listRecentItems({ limit, sort }, overrides);
        emitOk(data, { elapsedMs: Date.now() - startedAt });
        return;
      }

      case "s2": {
        const query = parsed.positionals.slice(1).join(" ");
        if (!query) {
          emitError("MISSING_ARGUMENT", 'Missing Semantic Scholar search text. Use: zotagent s2 "<text>"');
          return;
        }
        const limitInput = parseNumericFlag(parsed.flags, "limit", {
          requirement: "a positive integer",
          constraint: "a positive integer",
          integer: true,
          min: 1,
        });
        if (limitInput.error) {
          emitError("INVALID_ARGUMENT", limitInput.error);
          return;
        }
        const limit = limitInput.value ?? 10;
        const data = await searchSemanticScholar(query, limit, overrides);
        emitOk(data, { elapsedMs: Date.now() - startedAt });
        return;
      }

      case "search": {
        const query = parsed.positionals.slice(1).join(" ");
        if (!query) {
          emitError("MISSING_ARGUMENT", 'Missing search text. Use: zotagent search "<text>"');
          return;
        }
        const semantic = getBooleanFlag(parsed.flags, "semantic");
        const keyword = getBooleanFlag(parsed.flags, "keyword");
        if (semantic && keyword) {
          emitError("UNEXPECTED_ARGUMENT", '`--keyword` cannot be combined with `--semantic`.');
          return;
        }
        const limitInput = parseNumericFlag(parsed.flags, "limit", {
          requirement: "a positive integer",
          constraint: "a positive integer",
          integer: true,
          min: 1,
        });
        if (limitInput.error) {
          emitError("INVALID_ARGUMENT", limitInput.error);
          return;
        }
        const minScoreInput = parseNumericFlag(parsed.flags, "min-score", {
          requirement: "a number",
          constraint: "a finite number",
        });
        if (minScoreInput.error) {
          emitError("INVALID_ARGUMENT", minScoreInput.error);
          return;
        }
        const limit = limitInput.value ?? 10;
        const minScore = minScoreInput.value;
        const data = await searchLiterature(query, limit, overrides, openQmdClient, {
          ...(semantic ? { semantic: true } : {}),
          ...(minScore !== undefined ? { minScore } : {}),
          ...(semantic ? { progress: (message: string) => process.stderr.write(`${message}\n`) } : {}),
        });
        emitOk(data, { elapsedMs: Date.now() - startedAt });
        return;
      }

      case "search-in": {
        const query = parsed.positionals.slice(1).join(" ");
        if (!query) {
          emitError("MISSING_ARGUMENT", 'Missing search text. Use: zotagent search-in "<text>" --key <key>');
          return;
        }
        const key = getKeyFlag(parsed.flags);
        if (!key) {
          emitError("MISSING_ARGUMENT", "Provide --key <key>.");
          return;
        }
        const limitInput = parseNumericFlag(parsed.flags, "limit", {
          requirement: "a positive integer",
          constraint: "a positive integer",
          integer: true,
          min: 1,
        });
        if (limitInput.error) {
          emitError("INVALID_ARGUMENT", limitInput.error);
          return;
        }
        try {
          const data = searchWithinDocuments(
            query,
            { key },
            limitInput.value ?? 10,
            overrides,
          );
          emitOk(data, { elapsedMs: Date.now() - startedAt });
          return;
        } catch (error) {
          emitDocumentLookupError("SEARCH_IN", error);
          return;
        }
      }

      case "metadata": {
        if (parsed.flags.field === true) {
          emitError(
            "INVALID_ARGUMENT",
            `\`--field\` requires a value. Use one or more of: ${METADATA_FIELDS.join(", ")}.`,
          );
          return;
        }
        const query = parsed.positionals.slice(1).join(" ");
        const filterFlagFields: MetadataField[] = ["author", "year", "title", "journal", "publisher"];
        const filters: Partial<Record<MetadataField, string>> = {};
        for (const field of filterFlagFields) {
          if (parsed.flags[field] === true) {
            emitError("INVALID_ARGUMENT", `\`--${field}\` requires a value.`);
            return;
          }
          const value = getStringFlag(parsed.flags, field);
          if (value) filters[field] = value;
        }
        const hasFilters = Object.keys(filters).length > 0;
        if (!query && !hasFilters) {
          emitError(
            "MISSING_ARGUMENT",
            'Provide a positional query or at least one field filter. Use: zotagent metadata "<text>" [--author/--year/--title/--journal/--publisher <value>]',
          );
          return;
        }
        const requestedFields = [...new Set(getStringListFlag(parsed.flags, "field"))];
        const invalidFields = requestedFields.filter(
          (field): field is string => !METADATA_FIELDS.includes(field as MetadataField),
        );
        if (invalidFields.length > 0) {
          emitError(
            "INVALID_ARGUMENT",
            `Unsupported metadata field: ${invalidFields.join(", ")}. Use one or more of: ${METADATA_FIELDS.join(", ")}.`,
          );
          return;
        }
        const limitInput = parseNumericFlag(parsed.flags, "limit", {
          requirement: "a positive integer",
          constraint: "a positive integer",
          integer: true,
          min: 1,
        });
        if (limitInput.error) {
          emitError("INVALID_ARGUMENT", limitInput.error);
          return;
        }
        const limit = limitInput.value ?? 20;
        const data = await searchMetadata(query, limit, overrides, {
          ...(requestedFields.length > 0 ? { fields: requestedFields as MetadataField[] } : {}),
          ...(getBooleanFlag(parsed.flags, "has-file") ? { hasFile: true } : {}),
          ...(getBooleanFlag(parsed.flags, "abstract") ? { includeAbstract: true } : {}),
          ...(hasFilters ? { filters } : {}),
        });
        emitOk(data, { elapsedMs: Date.now() - startedAt });
        return;
      }

      case "blocks": {
        const key = getKeyFlag(parsed.flags);
        if (!key) {
          emitError("MISSING_ARGUMENT", "Provide --key <key>.");
          return;
        }
        const offsetBlockInput = parseNumericFlag(parsed.flags, "offset-block", {
          requirement: "a non-negative integer",
          constraint: "a non-negative integer",
          integer: true,
          min: 0,
        });
        if (offsetBlockInput.error) {
          emitError("INVALID_ARGUMENT", offsetBlockInput.error);
          return;
        }
        const limitBlocksInput = parseNumericFlag(parsed.flags, "limit-blocks", {
          requirement: "a positive integer",
          constraint: "a positive integer",
          integer: true,
          min: 1,
        });
        if (limitBlocksInput.error) {
          emitError("INVALID_ARGUMENT", limitBlocksInput.error);
          return;
        }
        try {
          const data = getDocumentBlocks(
            {
              key,
              offsetBlock: offsetBlockInput.value ?? 0,
              limitBlocks: limitBlocksInput.value ?? 20,
            },
            overrides,
          );
          emitOk(data, { elapsedMs: Date.now() - startedAt });
          return;
        } catch (error) {
          emitDocumentLookupError("BLOCKS", error);
          return;
        }
      }

      case "fulltext": {
        const key = getKeyFlag(parsed.flags);
        if (!key) {
          emitError("MISSING_ARGUMENT", "Provide --key <key>.");
          return;
        }
        try {
          const data = fullTextDocument(
            {
              key,
              clean: getBooleanFlag(parsed.flags, "clean"),
            },
            overrides,
          );
          emitOk(data, { elapsedMs: Date.now() - startedAt });
          return;
        } catch (error) {
          emitDocumentLookupError("FULLTEXT", error);
          return;
        }
      }

      case "expand": {
        const key = getKeyFlag(parsed.flags);
        const blockStartInput = parseNumericFlag(parsed.flags, "block-start", {
          requirement: "a non-negative integer",
          constraint: "a non-negative integer",
          integer: true,
          min: 0,
        });
        if (blockStartInput.error) {
          emitError("INVALID_ARGUMENT", blockStartInput.error);
          return;
        }
        const blockEndInput = parseNumericFlag(parsed.flags, "block-end", {
          requirement: "a non-negative integer",
          constraint: "a non-negative integer",
          integer: true,
          min: 0,
        });
        if (blockEndInput.error) {
          emitError("INVALID_ARGUMENT", blockEndInput.error);
          return;
        }
        const radiusInput = parseNumericFlag(parsed.flags, "radius", {
          requirement: "a non-negative integer",
          constraint: "a non-negative integer",
          integer: true,
          min: 0,
        });
        if (radiusInput.error) {
          emitError("INVALID_ARGUMENT", radiusInput.error);
          return;
        }
        if (!key || blockStartInput.value === undefined) {
          emitError(
            "MISSING_ARGUMENT",
            "Provide --key <key> and --block-start <n> for expand.",
          );
          return;
        }
        const blockStartValue = blockStartInput.value;
        const blockEndValue = blockEndInput.value ?? blockStartValue;
        if (blockEndValue < blockStartValue) {
          emitError("INVALID_ARGUMENT", "`--block-end` must be greater than or equal to `--block-start`.");
          return;
        }
        try {
          const data = expandDocument(
            {
              key,
              blockStart: blockStartValue,
              blockEnd: blockEndValue,
              radius: radiusInput.value ?? 2,
            },
            overrides,
          );
          emitOk(data, { elapsedMs: Date.now() - startedAt });
          return;
        } catch (error) {
          emitDocumentLookupError("EXPAND", error);
          return;
        }
      }

      default:
        emitError("UNKNOWN_COMMAND", `Unknown command: ${command}`);
        return;
    }
  } catch (error) {
    if (error instanceof KeywordQuerySyntaxError) {
      emitError(
        "INVALID_ARGUMENT",
        error.message,
        undefined,
        { elapsedMs: Date.now() - startedAt },
      );
      return;
    }
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
