#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { runAdd, runAddJson, type AddRequest } from "./add.js";
import { BOOLEAN_FLAGS, COMMAND_FLAG_ALLOWLIST, GLOBAL_OVERRIDE_FLAGS, helpText } from "./cli-spec.js";
import { ConfigCommandError, runConfigCommand } from "./config-command.js";
import { getDataPaths, resolveConfig, type ConfigOverrides } from "./config.js";
import { diagnoseExtraction } from "./diagnose.js";
import { expandDocument, fullTextDocument, getDocumentBlocks, getIndexStatus, searchLiterature, searchWithinDocuments } from "./engine.js";
import { emitError, emitOk } from "./json.js";
import { JsonInputError } from "./json-input.js";
import { KeywordQuerySyntaxError } from "./keyword-db.js";
import { searchMetadata } from "./metadata.js";
import { openQmdClient } from "./qmd.js";
import { listRecentItems, type RecentSort } from "./recent.js";
import { searchSemanticScholar } from "./s2.js";
import { runSync } from "./sync.js";
import { TranslationServerError } from "./translation-server.js";
import type { MetadataField } from "./types.js";
import { compactHomePath } from "./utils.js";
import {
  getReadConfig,
  isValidCollectionKey,
  normalizeCollectionFilters,
  normalizeTagFilters,
  resolveItemKeyFilter,
} from "./zotero-http.js";

type FlagValue = string | string[] | boolean;

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, FlagValue>;
}

const METADATA_FIELDS: MetadataField[] = ["title", "author", "year", "abstract", "journal", "publisher"];


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

function parseTagFilters(flags: Record<string, FlagValue>): { tags?: string[]; error?: string } {
  if (!("tag" in flags)) return {};
  if (flags.tag === true) return { error: "`--tag` requires a value." };
  const tags = normalizeTagFilters(getStringListFlag(flags, "tag"));
  if (tags.length === 0) return { error: "`--tag` requires a non-empty value." };
  return { tags };
}

function parseCollectionFilters(
  flags: Record<string, FlagValue>,
): { collectionKeys?: string[]; error?: string } {
  if (!("collection-key" in flags)) return {};
  if (flags["collection-key"] === true) return { error: "`--collection-key` requires a value." };
  const keys = normalizeCollectionFilters(getStringListFlag(flags, "collection-key"));
  if (keys.length === 0) return { error: "`--collection-key` requires a non-empty value." };
  const invalid = keys.filter((key) => !isValidCollectionKey(key));
  if (invalid.length > 0) {
    return {
      error: `\`--collection-key\` values must be 8-character Zotero keys (uppercase A–Z and digits). Invalid: ${invalid.join(", ")}`,
    };
  }
  return { collectionKeys: keys };
}

interface NumericFlagOptions {
  requirement: string;
  constraint: string;
  integer?: boolean;
  positive?: boolean;
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
  if (options.positive && value <= 0) {
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
    translationServerUrl: getStringFlag(flags, "translation-server-url"),
    embeddingProvider: getStringFlag(flags, "embedding-provider"),
    embeddingModel: getStringFlag(flags, "embedding-model"),
    googleApiKey: getStringFlag(flags, "google-api-key"),
  };
}

function printHelp(): void {
  console.log(helpText());
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
        const syncStartedAt = Date.now();
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
          { elapsedMs: Date.now() - syncStartedAt },
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
          );
          return;
        } catch (error) {
          if (error instanceof ConfigCommandError) {
            emitError(error.code, error.message);
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
          "from-url",
          "identifier",
          "select",
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
          "attach-file",
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
            "from-url",
            "identifier",
            "select",
            "title",
            "author",
            "year",
            "publication",
            "url",
            "url-date",
            "access-date",
            "item-type",
            "attach-file",
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
            emitOk(await runAddJson(jsonSource, overrides, getStringFlag(parsed.flags, "collection-key")));
          } catch (error) {
            if (error instanceof JsonInputError) {
              emitError("INVALID_ARGUMENT", error.message, error.details);
              return;
            }
            const message = error instanceof Error ? error.message : String(error);
            emitError("ADD_JSON_FAILED", message);
          }
          return;
        }
        const doi = getStringFlag(parsed.flags, "doi");
        const s2PaperId = getStringFlag(parsed.flags, "s2-paper-id");
        const fromUrl = getStringFlag(parsed.flags, "from-url");
        const identifier = getStringFlag(parsed.flags, "identifier");
        const select = getStringFlag(parsed.flags, "select");
        const title = getStringFlag(parsed.flags, "title");
        const sourceFlags = [
          ["--doi", doi],
          ["--s2-paper-id", s2PaperId],
          ["--from-url", fromUrl],
          ["--identifier", identifier],
        ].filter(([, value]) => value !== undefined);
        if (sourceFlags.length > 1) {
          emitError(
            "UNEXPECTED_ARGUMENT",
            `Use only one of --doi, --s2-paper-id, --from-url, --identifier. Got: ${sourceFlags
              .map(([flag]) => flag)
              .join(", ")}`,
          );
          return;
        }
        if (select && !fromUrl) {
          emitError("UNEXPECTED_ARGUMENT", "--select is only valid together with --from-url.");
          return;
        }
        if (sourceFlags.length === 0 && !title) {
          emitError(
            "MISSING_ARGUMENT",
            "Provide --doi <doi>, --s2-paper-id <id>, --from-url <url>, --identifier <id>, --json <file|->, or --title <text> for add.",
          );
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
          ...(getStringFlag(parsed.flags, "attach-file")
            ? { attachFile: getStringFlag(parsed.flags, "attach-file")! }
            : {}),
        };
        const request: AddRequest = fromUrl
          ? { kind: "url", url: fromUrl, ...(select ? { select } : {}), input: sharedInput }
          : identifier
            ? { kind: "identifier", identifier, input: sharedInput }
            : s2PaperId
              ? { kind: "s2", paperId: s2PaperId, input: sharedInput }
              : { kind: "doi-or-manual", input: sharedInput };
        try {
          const outcome = await runAdd(request, overrides);
          if ("multiple" in outcome) {
            emitError(
              "MULTIPLE_RESULTS",
              `${outcome.choices.length} candidate items found at ${outcome.url}. Re-run the same command with --select <key> to import one.`,
              { url: outcome.url, choices: outcome.choices },
            );
            return;
          }
          emitOk(outcome);
        } catch (error) {
          if (error instanceof TranslationServerError) {
            emitError(error.code, error.message, error.details);
            return;
          }
          throw error;
        }
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
        emitOk(data);
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
        emitOk(data);
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
        const tagInput = parseTagFilters(parsed.flags);
        if (tagInput.error) {
          emitError("INVALID_ARGUMENT", tagInput.error);
          return;
        }
        const collectionInput = parseCollectionFilters(parsed.flags);
        if (collectionInput.error) {
          emitError("INVALID_ARGUMENT", collectionInput.error);
          return;
        }
        if (semantic && tagInput.tags) {
          emitError("UNEXPECTED_ARGUMENT", "`--tag` cannot be combined with `--semantic`; tag filtering currently works with keyword search.");
          return;
        }
        if (semantic && collectionInput.collectionKeys) {
          emitError("UNEXPECTED_ARGUMENT", "`--collection-key` cannot be combined with `--semantic`; collection filtering currently works with keyword search.");
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
        const itemKeys =
          tagInput.tags || collectionInput.collectionKeys
            ? await resolveItemKeyFilter(
                tagInput.tags,
                collectionInput.collectionKeys,
                getReadConfig(resolveConfig(overrides)),
              )
            : undefined;
        const data = await searchLiterature(query, limit, overrides, openQmdClient, {
          ...(semantic ? { semantic: true } : {}),
          ...(minScore !== undefined ? { minScore } : {}),
          ...(itemKeys !== undefined ? { itemKeys } : {}),
          ...(semantic ? { progress: (message: string) => process.stderr.write(`${message}\n`) } : {}),
        });
        emitOk(data);
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
          const data = await searchWithinDocuments(
            query,
            { key },
            limitInput.value ?? 10,
            overrides,
          );
          emitOk(data);
          return;
        } catch (error) {
          if (error instanceof KeywordQuerySyntaxError) {
            throw error;
          }
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
        const tagInput = parseTagFilters(parsed.flags);
        if (tagInput.error) {
          emitError("INVALID_ARGUMENT", tagInput.error);
          return;
        }
        const collectionInput = parseCollectionFilters(parsed.flags);
        if (collectionInput.error) {
          emitError("INVALID_ARGUMENT", collectionInput.error);
          return;
        }
        const hasFilters =
          Object.keys(filters).length > 0 ||
          tagInput.tags !== undefined ||
          collectionInput.collectionKeys !== undefined;
        if (!query && !hasFilters) {
          emitError(
            "MISSING_ARGUMENT",
            'Provide a positional query or at least one field/tag/collection filter. Use: zotagent metadata "<text>" [--author/--year/--title/--journal/--publisher/--tag/--collection-key <value>]',
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
        const itemKeys =
          tagInput.tags || collectionInput.collectionKeys
            ? await resolveItemKeyFilter(
                tagInput.tags,
                collectionInput.collectionKeys,
                getReadConfig(resolveConfig(overrides)),
              )
            : undefined;
        const data = await searchMetadata(query, limit, overrides, {
          ...(requestedFields.length > 0 ? { fields: requestedFields as MetadataField[] } : {}),
          ...(getBooleanFlag(parsed.flags, "has-file") ? { hasFile: true } : {}),
          ...(getBooleanFlag(parsed.flags, "abstract") ? { includeAbstract: true } : {}),
          ...(hasFilters ? { filters } : {}),
          ...(itemKeys !== undefined ? { itemKeys } : {}),
        });
        emitOk(data);
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
          emitOk(data);
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
          emitOk(data);
          return;
        } catch (error) {
          emitDocumentLookupError("FULLTEXT", error);
          return;
        }
      }

      case "expand": {
        const key = getKeyFlag(parsed.flags);
        const offsetInput = parseNumericFlag(parsed.flags, "offset", {
          requirement: "a non-negative integer",
          constraint: "a non-negative integer",
          integer: true,
          min: 0,
        });
        if (offsetInput.error) {
          emitError("INVALID_ARGUMENT", offsetInput.error);
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
        if (!key || offsetInput.value === undefined) {
          emitError(
            "MISSING_ARGUMENT",
            "Provide --key <key> and --offset <n> for expand.",
          );
          return;
        }
        try {
          const data = expandDocument(
            {
              key,
              offset: offsetInput.value,
              radius: radiusInput.value ?? 1000,
            },
            overrides,
          );
          emitOk(data);
          return;
        } catch (error) {
          emitDocumentLookupError("EXPAND", error);
          return;
        }
      }

      case "diagnose": {
        if (parsed.positionals.length > 1) {
          emitError("UNEXPECTED_ARGUMENT", "diagnose does not accept positional arguments.");
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
        const thresholdAvgInput = parseNumericFlag(parsed.flags, "threshold-avg", {
          requirement: "a positive number",
          constraint: "a positive number",
          positive: true,
          min: 0,
        });
        if (thresholdAvgInput.error) {
          emitError("INVALID_ARGUMENT", thresholdAvgInput.error);
          return;
        }
        const thresholdMedianInput = parseNumericFlag(parsed.flags, "threshold-median", {
          requirement: "a positive number",
          constraint: "a positive number",
          positive: true,
          min: 0,
        });
        if (thresholdMedianInput.error) {
          emitError("INVALID_ARGUMENT", thresholdMedianInput.error);
          return;
        }
        const data = await diagnoseExtraction(
          {
            ...(limitInput.value !== undefined ? { limit: limitInput.value } : {}),
            showAll: getBooleanFlag(parsed.flags, "all"),
            ...(thresholdAvgInput.value !== undefined ? { thresholdAvg: thresholdAvgInput.value } : {}),
            ...(thresholdMedianInput.value !== undefined ? { thresholdMedian: thresholdMedianInput.value } : {}),
          },
          overrides,
        );
        emitOk(data);
        return;
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
      );
      return;
    }
    emitError(
      "UNEXPECTED_ERROR",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
}

void main();
