import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import type { AppConfig, DataPaths, ZoteroLibraryType } from "./types.js";
import { resolveHomePath } from "./utils.js";

interface RawConfig {
  bibliographyJsonPath?: string;
  attachmentsRoot?: string;
  dataDir?: string;
  qmdEmbedModel?: string;
  semanticScholarApiKey?: string;
  zoteroLibraryId?: string;
  zoteroLibraryType?: string;
  zoteroCollectionKey?: string;
  zoteroApiKey?: string;
  embeddingProvider?: string;
  embeddingModel?: string;
  googleApiKey?: string;
}

export interface ConfigOverrides {
  bibliographyJsonPath?: string;
  attachmentsRoot?: string;
  dataDir?: string;
  qmdEmbedModel?: string;
  semanticScholarApiKey?: string;
  zoteroLibraryId?: string;
  zoteroLibraryType?: string;
  zoteroCollectionKey?: string;
  zoteroApiKey?: string;
  embeddingProvider?: string;
  embeddingModel?: string;
  googleApiKey?: string;
}

const DEFAULTS = {
  bibliographyJsonPath: "~/Library/CloudStorage/Dropbox/bibliography/bibliography.json",
  attachmentsRoot: "~/Library/Mobile Documents/com~apple~CloudDocs/Zotero",
  dataDir: "~/Library/Mobile Documents/com~apple~CloudDocs/Zotlit",
  qmdEmbedModel: undefined,
};

function firstDefined(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function resolveLibraryType(raw: string | undefined, warnings: string[]): ZoteroLibraryType | undefined {
  if (!raw) return undefined;
  if (raw === "user" || raw === "group") return raw;
  warnings.push(`Config field 'zoteroLibraryType' must be either 'user' or 'group'.`);
  return undefined;
}

export function getConfigPath(): string {
  return resolveHomePath("~/.zotlit/config.json");
}

function readConfigFile(): RawConfig {
  const path = getConfigPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as RawConfig;
}

export function resolveConfig(overrides: ConfigOverrides = {}): AppConfig {
  const fileConfig = readConfigFile();
  const warnings: string[] = [];
  const deprecatedFields = [
    ["embeddingProvider", overrides.embeddingProvider, process.env.ZOTLIT_EMBEDDING_PROVIDER, process.env.EMBEDDING_PROVIDER, fileConfig.embeddingProvider],
    ["embeddingModel", overrides.embeddingModel, process.env.ZOTLIT_EMBEDDING_MODEL, process.env.EMBEDDING_MODEL, fileConfig.embeddingModel],
    ["googleApiKey", overrides.googleApiKey, process.env.ZOTLIT_GOOGLE_API_KEY, process.env.GOOGLE_API_KEY, fileConfig.googleApiKey],
  ] as const;

  for (const [field, ...values] of deprecatedFields) {
    if (values.some((value) => typeof value === "string" && value.length > 0)) {
      warnings.push(`Config field '${field}' is deprecated in zotlit and is ignored.`);
    }
  }

  return {
    bibliographyJsonPath: resolveHomePath(
      firstDefined(
        overrides.bibliographyJsonPath,
        process.env.ZOTLIT_BIBLIOGRAPHY_JSON_PATH,
        fileConfig.bibliographyJsonPath,
        DEFAULTS.bibliographyJsonPath,
      )!,
    ),
    attachmentsRoot: resolveHomePath(
      firstDefined(
        overrides.attachmentsRoot,
        process.env.ZOTLIT_ATTACHMENTS_ROOT,
        fileConfig.attachmentsRoot,
        DEFAULTS.attachmentsRoot,
      )!,
    ),
    dataDir: resolveHomePath(
      firstDefined(
        overrides.dataDir,
        process.env.ZOTLIT_DATA_DIR,
        fileConfig.dataDir,
        DEFAULTS.dataDir,
      )!,
    ),
    qmdEmbedModel: firstDefined(
      overrides.qmdEmbedModel,
      process.env.ZOTLIT_QMD_EMBED_MODEL,
      process.env.QMD_EMBED_MODEL,
      fileConfig.qmdEmbedModel,
      DEFAULTS.qmdEmbedModel,
    ),
    semanticScholarApiKey: firstDefined(
      overrides.semanticScholarApiKey,
      process.env.ZOTLIT_SEMANTIC_SCHOLAR_API_KEY,
      process.env.SEMANTIC_SCHOLAR_API_KEY,
      fileConfig.semanticScholarApiKey,
    ),
    zoteroLibraryId: firstDefined(
      overrides.zoteroLibraryId,
      process.env.ZOTLIT_ZOTERO_LIBRARY_ID,
      process.env.ZOTERO_LIBRARY_ID,
      fileConfig.zoteroLibraryId,
    ),
    zoteroLibraryType: resolveLibraryType(
      firstDefined(
        overrides.zoteroLibraryType,
        process.env.ZOTLIT_ZOTERO_LIBRARY_TYPE,
        process.env.ZOTERO_LIBRARY_TYPE,
        fileConfig.zoteroLibraryType,
      ),
      warnings,
    ),
    zoteroCollectionKey: firstDefined(
      overrides.zoteroCollectionKey,
      process.env.ZOTLIT_ZOTERO_COLLECTION_KEY,
      process.env.ZOTERO_COLLECTION_KEY,
      fileConfig.zoteroCollectionKey,
    ),
    zoteroApiKey: firstDefined(
      overrides.zoteroApiKey,
      process.env.ZOTLIT_ZOTERO_API_KEY,
      process.env.ZOTERO_API_KEY,
      fileConfig.zoteroApiKey,
    ),
    warnings,
  };
}

export function getDataPaths(dataDir: string): DataPaths {
  const resolvedDataDir = resolveHomePath(dataDir);
  const indexDir = resolve(resolvedDataDir, "index");
  return {
    logsDir: resolve(resolvedDataDir, "logs"),
    latestSyncLogPath: resolve(resolvedDataDir, "logs", "sync-latest.log"),
    normalizedDir: resolve(resolvedDataDir, "normalized"),
    manifestsDir: resolve(resolvedDataDir, "manifests"),
    indexDir,
    tantivyDir: resolve(indexDir, "tantivy"),
    tempDir: resolve(tmpdir(), "zotlit"),
    qmdDbPath: resolve(indexDir, "qmd.sqlite"),
    catalogPath: resolve(indexDir, "catalog.json"),
  };
}

export function getConfigDir(): string {
  return dirname(getConfigPath());
}
