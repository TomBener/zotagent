#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { addS2PaperToZotero, addToZotero } from "./add.js";
import { ConfigCommandError, runConfigCommand } from "./config-command.js";
import { getDataPaths, resolveConfig, type ConfigOverrides } from "./config.js";
import { expandDocument, fullTextDocument, getDocumentBlocks, getIndexStatus, searchLiterature, searchWithinDocuments } from "./engine.js";
import { emitError, emitOk } from "./json.js";
import { KeywordQuerySyntaxError } from "./keyword-db.js";
import { searchMetadata } from "./metadata.js";
import { openQmdClient } from "./qmd.js";
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
      Build or refresh the local index of PDF, EPUB, HTML, and TXT attachments.
      Unchanged extraction errors are skipped by default; pass --retry-errors to retry them.
        --attachments-root <path>   Index only a Zotero subfolder.
        --retry-errors              Retry unchanged files that failed extraction earlier.
        --pdf-timeout-ms <n>        Override the OpenDataLoader timeout for each PDF extraction call.
        --pdf-batch-size <n>        Override the maximum number of PDFs per extraction batch.

  status
      Show attachment counts, local index paths, and qmd status.

Add to Zotero
  add [--doi <doi> | --s2-paper-id <id>] [--title <text>] [--author <name>] [--year <text>]
      [--publication <text>] [--url <url>] [--url-date <date>] [--collection-key <key>] [--item-type <type>]
      Create a Zotero item and return its itemKey. Prefer --doi when available.
      --s2-paper-id imports from Semantic Scholar (and still prefers DOI when present).
        --doi <doi>                 Import from DOI metadata when possible.
        --s2-paper-id <id>          Import a Semantic Scholar paper by paperId.
        --title <text>              Set title for manual add or DOI fallback.
        --author <name>             Add an author. Repeat for multiple authors.
        --year <text>               Set the Zotero date field.
        --publication <text>        Set journal, website, or container title when supported.
        --url <url>                 Set the item URL.
        --url-date <date>           Set the access date for the URL. Alias: --access-date.
        --collection-key <key>      Add the new item to a Zotero collection by collection key.
        --item-type <type>          Override the Zotero item type. Default: journalArticle or webpage.

  s2 "<text>" [--limit <n>]
      Search Semantic Scholar; pass a returned paperId to \`add --s2-paper-id\`.

Search
  search "<text>" [--keyword | --semantic] [--limit <n>] [--min-score <n>]
      Search indexed documents. Pass at most one of --keyword (default) or --semantic.
      Default is keyword search (FTS5 with porter stemming): "exact phrase", OR, NOT,
      term NEAR/<n> term, prefix*. Use NEAR/50 for proximity; NEAR(...) is not accepted.
      Chinese, Japanese, and Korean text is supported with accurate phrase matching.
      --semantic uses qmd vector search with LLM query expansion (slower, heavier).
        --limit <n>                 Return up to n search results. Default: 10 for search, 20 for metadata.
        --min-score <n>             Drop lower-scoring search hits before mapping.

  search-in "<text>" (--item-key <key> | --citation-key <key>) [--limit <n>]
      Search within one indexed item's attachments (exact phrase and term match).

  metadata "<text>" [--limit <n>] [--field <field>] [--has-file] [--abstract]
      Search Zotero bibliography metadata read from bibliographyJsonPath.
        --field <field>             Limit metadata search to title, author, year, abstract, journal,
                                    or publisher. Repeatable.
        --has-file                  Keep only metadata results with a supported indexed attachment.
        --abstract                  Include the abstract in each result. Omitted by default to keep
                                    bulk responses compact for agents.

Retrieval
  blocks (--item-key <key> | --citation-key <key>) [--offset-block <n>] [--limit-blocks <n>]
      Return paginated blocks from one indexed item.
      When one item has multiple indexed attachments, they are merged into one logical
      document with monotonic block indices and "# Attachment: <name>" dividers between them.
        --offset-block <n>          Start at block n. Default: 0.
        --limit-blocks <n>          Return up to n blocks. Default: 20.

  fulltext (--item-key <key> | --citation-key <key>) [--clean]
      Output agent-friendly full text for one item. Multi-attachment items return one
      merged markdown document.
        --clean                     Apply heuristic cleanup (drops duplicate blocks and
                                    common boilerplate such as citation notices and TOC lines).

  expand (--item-key <key> | --citation-key <key>) --block-start <n> [--block-end <n>] [--radius <n>]
      Expand around a search hit or block range from a local manifest.
      Block indices are item-global; feed blockStart from search results directly.
        --block-start <n>           Start block for expand.
        --block-end <n>             End block for expand. Default: block-start.
        --radius <n>                Include n blocks before and after. Default: 2.

Document selectors (used by search-in, blocks, fulltext, expand)
  --item-key <key>              Resolve an indexed item by Zotero item key.
  --citation-key <key>          Resolve an indexed item by citation key.

Other
  version, --version            Print the current zotagent version.
  help, --help                  Show this help. Also shown when no command is given.

Config
  config
      Interactively set ~/.zotagent/config.json.

  Paths and credentials are read from ~/.zotagent/config.json.
  Any field can also come from a ZOTAGENT_* env var (ZOTERO_* /
  SEMANTIC_SCHOLAR_* are accepted as unprefixed fallbacks).
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
        const doi = getStringFlag(parsed.flags, "doi");
        const s2PaperId = getStringFlag(parsed.flags, "s2-paper-id");
        const title = getStringFlag(parsed.flags, "title");
        if (doi && s2PaperId) {
          emitError("UNEXPECTED_ARGUMENT", "Use either --doi <doi> or --s2-paper-id <id>, not both.");
          return;
        }
        if (!doi && !s2PaperId && !title) {
          emitError("MISSING_ARGUMENT", "Provide --doi <doi>, --s2-paper-id <id>, or --title <text> for add.");
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

      case "s2": {
        if ("query" in parsed.flags) {
          emitError("UNEXPECTED_ARGUMENT", '`--query` is not supported. Use: zotagent s2 "<text>"');
          return;
        }
        const invalidFlags = ["keyword", "semantic", "min-score", "field", "has-file", "has-pdf"].filter(
          (flag) => flag in parsed.flags,
        );
        if (invalidFlags.length > 0) {
          emitError(
            "UNEXPECTED_ARGUMENT",
            `s2 only supports --limit. Remove: ${invalidFlags.map((flag) => `--${flag}`).join(", ")}`,
          );
          return;
        }
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
        if ("query" in parsed.flags) {
          emitError("UNEXPECTED_ARGUMENT", '`--query` has been removed. Use: zotagent search "<text>"');
          return;
        }
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
        if ("query" in parsed.flags) {
          emitError("UNEXPECTED_ARGUMENT", '`--query` has been removed. Use: zotagent search-in "<text>" (--item-key <key> | --citation-key <key>)');
          return;
        }
        const query = parsed.positionals.slice(1).join(" ");
        if (!query) {
          emitError("MISSING_ARGUMENT", 'Missing search text. Use: zotagent search-in "<text>" (--item-key <key> | --citation-key <key>)');
          return;
        }
        if ("file" in parsed.flags) {
          emitError("UNEXPECTED_ARGUMENT", "`--file` has been removed. Use --item-key <key> or --citation-key <key>.");
          return;
        }
        const itemKey = getStringFlag(parsed.flags, "item-key");
        const citationKey = getStringFlag(parsed.flags, "citation-key");
        const selectorCount = Number(Boolean(itemKey)) + Number(Boolean(citationKey));
        if (selectorCount > 1) {
          emitError(
            "UNEXPECTED_ARGUMENT",
            "Provide exactly one of --item-key <key> or --citation-key <key>.",
          );
          return;
        }
        if (selectorCount === 0) {
          emitError("MISSING_ARGUMENT", "Provide one of --item-key <key> or --citation-key <key>.");
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
            {
              ...(itemKey ? { itemKey } : {}),
              ...(citationKey ? { citationKey } : {}),
            },
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
        if ("query" in parsed.flags) {
          emitError("UNEXPECTED_ARGUMENT", '`--query` is not supported. Use: zotagent metadata "<text>"');
          return;
        }
        const invalidFlags = ["keyword", "semantic", "min-score"].filter(
          (flag) => flag in parsed.flags,
        );
        if (invalidFlags.length > 0) {
          emitError(
            "UNEXPECTED_ARGUMENT",
            `metadata only supports --limit, --field, --has-file, and --abstract. Remove: ${invalidFlags
              .map((flag) => `--${flag}`)
              .join(", ")}`,
          );
          return;
        }
        if (parsed.flags.field === true) {
          emitError(
            "INVALID_ARGUMENT",
            `\`--field\` requires a value. Use one or more of: ${METADATA_FIELDS.join(", ")}.`,
          );
          return;
        }
        const query = parsed.positionals.slice(1).join(" ");
        if (!query) {
          emitError("MISSING_ARGUMENT", 'Missing metadata search text. Use: zotagent metadata "<text>"');
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
        if ("has-pdf" in parsed.flags) {
          emitError("RENAMED_FLAG", "`--has-pdf` has been renamed to `--has-file`.");
          return;
        }
        const limit = limitInput.value ?? 20;
        const data = await searchMetadata(query, limit, overrides, {
          ...(requestedFields.length > 0 ? { fields: requestedFields as MetadataField[] } : {}),
          ...(getBooleanFlag(parsed.flags, "has-file") ? { hasFile: true } : {}),
          ...(getBooleanFlag(parsed.flags, "abstract") ? { includeAbstract: true } : {}),
        });
        emitOk(data, { elapsedMs: Date.now() - startedAt });
        return;
      }

      case "blocks": {
        if ("file" in parsed.flags) {
          emitError("UNEXPECTED_ARGUMENT", "`--file` has been removed. Use --item-key <key> or --citation-key <key>.");
          return;
        }
        const itemKey = getStringFlag(parsed.flags, "item-key");
        const citationKey = getStringFlag(parsed.flags, "citation-key");
        const selectorCount = Number(Boolean(itemKey)) + Number(Boolean(citationKey));
        if (selectorCount > 1) {
          emitError(
            "UNEXPECTED_ARGUMENT",
            "Provide exactly one of --item-key <key> or --citation-key <key>.",
          );
          return;
        }
        if (selectorCount === 0) {
          emitError("MISSING_ARGUMENT", "Provide one of --item-key <key> or --citation-key <key>.");
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
              ...(itemKey ? { itemKey } : {}),
              ...(citationKey ? { citationKey } : {}),
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
        if ("file" in parsed.flags) {
          emitError("UNEXPECTED_ARGUMENT", "`--file` has been removed. Use --item-key <key> or --citation-key <key>.");
          return;
        }
        const itemKey = getStringFlag(parsed.flags, "item-key");
        const citationKey = getStringFlag(parsed.flags, "citation-key");
        const selectorCount = Number(Boolean(itemKey)) + Number(Boolean(citationKey));
        if (selectorCount > 1) {
          emitError(
            "UNEXPECTED_ARGUMENT",
            "Provide exactly one of --item-key <key> or --citation-key <key>.",
          );
          return;
        }
        if (selectorCount === 0) {
          emitError("MISSING_ARGUMENT", "Provide one of --item-key <key> or --citation-key <key>.");
          return;
        }
        try {
          const data = fullTextDocument(
            {
              ...(itemKey ? { itemKey } : {}),
              ...(citationKey ? { citationKey } : {}),
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
        if ("file" in parsed.flags) {
          emitError("UNEXPECTED_ARGUMENT", "`--file` has been removed. Use --item-key <key> or --citation-key <key>.");
          return;
        }
        const itemKey = getStringFlag(parsed.flags, "item-key");
        const citationKey = getStringFlag(parsed.flags, "citation-key");
        const selectorCount = Number(Boolean(itemKey)) + Number(Boolean(citationKey));
        if (selectorCount > 1) {
          emitError(
            "UNEXPECTED_ARGUMENT",
            "Provide exactly one of --item-key <key> or --citation-key <key>.",
          );
          return;
        }
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
        if (selectorCount === 0 || blockStartInput.value === undefined) {
          emitError(
            "MISSING_ARGUMENT",
            "Provide one of --item-key <key> or --citation-key <key>, and --block-start <n> for expand.",
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
              ...(itemKey ? { itemKey } : {}),
              ...(citationKey ? { citationKey } : {}),
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
