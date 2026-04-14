#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { addS2PaperToZotero, addToZotero } from "./add.js";
import { getDataPaths, type ConfigOverrides } from "./config.js";
import { expandDocument, fullTextDocuments, getIndexStatus, readDocument, searchLiterature, searchWithinDocuments } from "./engine.js";
import { emitError, emitOk } from "./json.js";
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
  "clean",
  "exact",
  "has-pdf",
  "help",
  "rerank",
  "retry-errors",
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
  console.log(`zotlit

Search indexed Zotero PDFs or bibliography metadata and follow PDF hits with read or expand.

Usage:
  zotlit sync [--attachments-root <path>] [--retry-errors] [--pdf-timeout-ms <n>] [--pdf-batch-size <n>]
  zotlit status
  zotlit version
  zotlit add [--doi <doi> | --s2-paper-id <id>] [--title <text>] [--author <name>] [--year <text>] [--publication <text>] [--url <url>] [--url-date <date>] [--collection-key <key>] [--item-type <type>]
  zotlit s2 "<text>" [--limit <n>]
  zotlit search "<text>" [--exact] [--limit <n>] [--min-score <n>] [--rerank]
  zotlit search-in "<text>" (--file <path> | --item-key <key> | --citation-key <key>) [--limit <n>]
  zotlit metadata "<text>" [--limit <n>] [--field <field>] [--has-pdf]
  zotlit read (--file <path> | --item-key <key> | --citation-key <key>) [--offset-block <n>] [--limit-blocks <n>]
  zotlit fulltext (--file <path> | --item-key <key> | --citation-key <key>) [--clean]
  zotlit expand (--file <path> | --item-key <key> | --citation-key <key>) --block-start <n> [--block-end <n>] [--radius <n>]

Commands:
  sync
    Refresh the local index.
    Use --attachments-root to index only a Zotero subfolder.
    Unchanged extraction errors are skipped by default; use --retry-errors to retry them.

  status
    Show attachment counts, local index paths, and qmd status.

  version
    Print the current zotlit version.

  add
    Add a Zotero item and return its itemKey immediately.
    Prefer --doi when available. --s2-paper-id imports from Semantic Scholar and still prefers DOI when present.

  s2
    Search Semantic Scholar papers by keyword.
    Use a returned paperId with add --s2-paper-id to create a Zotero item.

  search
    Search indexed Zotero PDFs.
    --exact uses exact substring search.
    qmd reranking is skipped by default; --rerank enables it for narrower queries.
    --exact cannot be combined with --rerank.

  search-in
    Search within one indexed document or a selected set of matching attachments.
    Use one of --file, --item-key, or --citation-key to limit the search scope.

  metadata
    Search Zotero bibliography metadata from bibliography.json.
    --field can be repeated and supports: title, author, year, abstract, journal, publisher.
    --has-pdf keeps only results with a supported PDF attachment path.

  read
    Read blocks directly from a local manifest.
    Use one of --file, --item-key, or --citation-key.

  fulltext
    Output agent-friendly full text from a local manifest.
    Returns the original normalized markdown by default, without content filtering.
    Use --clean to remove duplicate blocks and common boilerplate such as citation notices and table-of-contents lines.
    Returns all matching attachments for --item-key or --citation-key.
    Use one of --file, --item-key, or --citation-key.

  expand
    Expand around a search hit or block range from a local manifest.
    Use one of --file, --item-key, or --citation-key.

Options:
  --attachments-root <path>   Limit sync to a Zotero subfolder.
  --retry-errors              Retry unchanged PDFs that failed extraction earlier.
  --pdf-timeout-ms <n>        Override the OpenDataLoader timeout for each PDF extraction call.
  --pdf-batch-size <n>        Override the maximum number of PDFs per extraction batch.
  --doi <doi>                 Import from DOI metadata when possible.
  --s2-paper-id <id>          Import a Semantic Scholar paper by paperId.
  --title <text>              Set title for manual add or DOI fallback.
  --author <name>             Add an author. Repeat for multiple authors.
  --year <text>               Set the Zotero date field.
  --publication <text>        Set journal, website, or container title when supported.
  --url <url>                 Set the item URL.
  --url-date <date>           Set the access date for the URL.
  --collection-key <key>      Add the new item to a Zotero collection by collection key.
  --item-type <type>          Override the Zotero item type. Default: journalArticle or webpage.
  --item-key <key>            Resolve an indexed attachment by Zotero item key for search-in, read, fulltext, or expand.
  --citation-key <key>        Resolve an indexed attachment by citation key for search-in, read, fulltext, or expand.
  --clean                     For fulltext, apply heuristic cleanup instead of returning the original normalized markdown.
  --exact                     Use exact substring search.
  --limit <n>                 Return up to n search results. Default: 10 for search, 20 for metadata.
  --min-score <n>             Drop lower-scoring search hits before mapping.
  --rerank                    Enable qmd reranking for search. Slower, useful for narrower queries.
  --field <field>             Limit metadata search to title, author, year, abstract, journal, or publisher.
  --has-pdf                   Keep only metadata results with a supported PDF attachment path.
  --offset-block <n>          Start reading at block n. Default: 0.
  --limit-blocks <n>          Read up to n blocks. Default: 20.
  --block-start <n>           Start block for expand.
  --block-end <n>             End block for expand. Default: block-start.
  --radius <n>                Include n blocks before and after. Default: 2.
  --version                   Print the current zotlit version.

Examples:
  zotlit add --doi "10.1016/j.econmod.2026.107590"
  zotlit add --s2-paper-id "f2005ed06241e8aa6f55f7ed9279a56b92038128"
  zotlit add --title "Working Paper" --author "Jane Doe" --year 2026 --collection-key "ABCD1234" --url "https://example.com"
  zotlit s2 "state-owned enterprise governance" --limit 5
  zotlit search "dangwei shuji" --exact
  zotlit search-in "dangwei shuji" --item-key KG326EEI
  zotlit search "state-owned enterprise governance" --limit 5 --min-score 0.4
  zotlit metadata "American Journal of Political Science" --field journal
  zotlit read --item-key KG326EEI
  zotlit read --citation-key lee2024aging
  zotlit fulltext --item-key KG326EEI
  zotlit fulltext --item-key KG326EEI --clean
  zotlit expand --item-key KG326EEI --block-start 10 --radius 2
  zotlit status
  zotlit version
  zotlit sync --attachments-root "/path/to/zotero/subfolder"
  zotlit sync --retry-errors --pdf-timeout-ms 1800000
  zotlit sync --pdf-batch-size 1

Config:
  Paths and other defaults are read from ~/.zotlit/config.json.
  The add command also needs zoteroLibraryId, zoteroLibraryType, and zoteroApiKey.
  zoteroLibraryType supports both user and group.
  zoteroCollectionKey sets the default collection for new add commands.
  The s2 command and --s2-paper-id also need semanticScholarApiKey.
`);
}

function compactPathMap(paths: ReturnType<typeof getDataPaths>): ReturnType<typeof getDataPaths> {
  return {
    logsDir: compactHomePath(paths.logsDir),
    latestSyncLogPath: compactHomePath(paths.latestSyncLogPath),
    normalizedDir: compactHomePath(paths.normalizedDir),
    manifestsDir: compactHomePath(paths.manifestsDir),
    indexDir: compactHomePath(paths.indexDir),
    exactDbPath: compactHomePath(paths.exactDbPath),
    tempDir: compactHomePath(paths.tempDir),
    qmdDbPath: compactHomePath(paths.qmdDbPath),
    catalogPath: compactHomePath(paths.catalogPath),
  };
}

function emitDocumentLookupError(prefix: "SEARCH_IN" | "READ" | "FULLTEXT" | "EXPAND", error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsedError = JSON.parse(message) as { message?: string; files?: string[] };
    emitError(
      `${prefix}_CONFLICT`,
      parsedError.message || message,
      parsedError.files ? { files: parsedError.files } : undefined,
    );
    return;
  } catch {
    emitError(`${prefix}_FAILED`, message);
    return;
  }
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
          emitError("UNEXPECTED_ARGUMENT", '`--query` is not supported. Use: zotlit s2 "<text>"');
          return;
        }
        const invalidFlags = ["exact", "rerank", "min-score", "field", "has-pdf"].filter(
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
          emitError("MISSING_ARGUMENT", 'Missing Semantic Scholar search text. Use: zotlit s2 "<text>"');
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
          emitError("UNEXPECTED_ARGUMENT", '`--query` has been removed. Use: zotlit search "<text>"');
          return;
        }
        const query = parsed.positionals.slice(1).join(" ");
        if (!query) {
          emitError("MISSING_ARGUMENT", 'Missing search text. Use: zotlit search "<text>"');
          return;
        }
        const exact = getBooleanFlag(parsed.flags, "exact");
        const explicitRerank = getBooleanFlag(parsed.flags, "rerank") ? true : undefined;
        if (exact && explicitRerank === true) {
          emitError("UNEXPECTED_ARGUMENT", '`--exact` cannot be combined with `--rerank`.');
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
          ...(exact ? { exact: true } : {}),
          ...(explicitRerank !== undefined ? { rerank: explicitRerank } : {}),
          ...(minScore !== undefined ? { minScore } : {}),
          ...(!exact ? { progress: (message: string) => process.stderr.write(`${message}\n`) } : {}),
        });
        emitOk(data, { elapsedMs: Date.now() - startedAt });
        return;
      }

      case "search-in": {
        if ("query" in parsed.flags) {
          emitError("UNEXPECTED_ARGUMENT", '`--query` has been removed. Use: zotlit search-in "<text>" (--file <path> | --item-key <key> | --citation-key <key>)');
          return;
        }
        const query = parsed.positionals.slice(1).join(" ");
        if (!query) {
          emitError("MISSING_ARGUMENT", 'Missing search text. Use: zotlit search-in "<text>" (--file <path> | --item-key <key> | --citation-key <key>)');
          return;
        }
        const file = getStringFlag(parsed.flags, "file");
        const itemKey = getStringFlag(parsed.flags, "item-key");
        const citationKey = getStringFlag(parsed.flags, "citation-key");
        const selectorCount = Number(Boolean(file)) + Number(Boolean(itemKey)) + Number(Boolean(citationKey));
        if (selectorCount > 1) {
          emitError(
            "UNEXPECTED_ARGUMENT",
            "Provide exactly one of --file <path>, --item-key <key>, or --citation-key <key>.",
          );
          return;
        }
        if (selectorCount === 0) {
          emitError("MISSING_ARGUMENT", "Provide one of --file <path>, --item-key <key>, or --citation-key <key>.");
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
              ...(file ? { file } : {}),
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
          emitError("UNEXPECTED_ARGUMENT", '`--query` is not supported. Use: zotlit metadata "<text>"');
          return;
        }
        const invalidFlags = ["exact", "rerank", "min-score"].filter(
          (flag) => flag in parsed.flags,
        );
        if (invalidFlags.length > 0) {
          emitError(
            "UNEXPECTED_ARGUMENT",
            `metadata only supports --limit, --field, and --has-pdf. Remove: ${invalidFlags
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
          emitError("MISSING_ARGUMENT", 'Missing metadata search text. Use: zotlit metadata "<text>"');
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
          ...(getBooleanFlag(parsed.flags, "has-pdf") ? { hasPdf: true } : {}),
        });
        emitOk(data, { elapsedMs: Date.now() - startedAt });
        return;
      }

      case "read": {
        const file = getStringFlag(parsed.flags, "file");
        const itemKey = getStringFlag(parsed.flags, "item-key");
        const citationKey = getStringFlag(parsed.flags, "citation-key");
        const selectorCount = Number(Boolean(file)) + Number(Boolean(itemKey)) + Number(Boolean(citationKey));
        if (selectorCount > 1) {
          emitError(
            "UNEXPECTED_ARGUMENT",
            "Provide exactly one of --file <path>, --item-key <key>, or --citation-key <key>.",
          );
          return;
        }
        if (selectorCount === 0) {
          emitError("MISSING_ARGUMENT", "Provide one of --file <path>, --item-key <key>, or --citation-key <key>.");
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
          const data = readDocument(
            {
              file,
              itemKey,
              citationKey,
              offsetBlock: offsetBlockInput.value ?? 0,
              limitBlocks: limitBlocksInput.value ?? 20,
            },
            overrides,
          );
          emitOk(data, { elapsedMs: Date.now() - startedAt });
          return;
        } catch (error) {
          emitDocumentLookupError("READ", error);
          return;
        }
      }

      case "fulltext": {
        const file = getStringFlag(parsed.flags, "file");
        const itemKey = getStringFlag(parsed.flags, "item-key");
        const citationKey = getStringFlag(parsed.flags, "citation-key");
        const selectorCount = Number(Boolean(file)) + Number(Boolean(itemKey)) + Number(Boolean(citationKey));
        if (selectorCount > 1) {
          emitError(
            "UNEXPECTED_ARGUMENT",
            "Provide exactly one of --file <path>, --item-key <key>, or --citation-key <key>.",
          );
          return;
        }
        if (selectorCount === 0) {
          emitError("MISSING_ARGUMENT", "Provide one of --file <path>, --item-key <key>, or --citation-key <key>.");
          return;
        }
        try {
          const data = fullTextDocuments(
            {
              ...(file ? { file } : {}),
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
        const file = getStringFlag(parsed.flags, "file");
        const itemKey = getStringFlag(parsed.flags, "item-key");
        const citationKey = getStringFlag(parsed.flags, "citation-key");
        const selectorCount = Number(Boolean(file)) + Number(Boolean(itemKey)) + Number(Boolean(citationKey));
        if (selectorCount > 1) {
          emitError(
            "UNEXPECTED_ARGUMENT",
            "Provide exactly one of --file <path>, --item-key <key>, or --citation-key <key>.",
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
            "Provide one of --file <path>, --item-key <key>, or --citation-key <key>, and --block-start <n> for expand.",
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
              ...(file ? { file } : {}),
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
