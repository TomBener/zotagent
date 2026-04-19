import type { ExpandedQuery, HybridQueryResult, QMDStore } from "@tobilu/qmd";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getDataPaths } from "./config.js";
import type { AppConfig } from "./types.js";
import { ensureDir } from "./utils.js";

const QMD_PACKAGE_ENTRY = fileURLToPath(import.meta.resolve("@tobilu/qmd"));
const QMD_PACKAGE_JSON_PATH = resolve(dirname(QMD_PACKAGE_ENTRY), "..", "package.json");

function readPackageVersion(path: string): string {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown };
  return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "unknown";
}

export const QMD_PACKAGE_VERSION = readPackageVersion(QMD_PACKAGE_JSON_PATH);

// Sentinel recorded on the catalog when the user has not pinned a model. The
// real default lives inside `@tobilu/qmd` and is not part of its public API;
// relying on `QMD_PACKAGE_VERSION` in `indexerSignature` is sufficient to
// invalidate indexes when the package (and therefore its default) changes.
export const QMD_DEFAULT_EMBED_MODEL_SENTINEL = "qmd-default";

export function resolveQmdEmbedModel(config: Pick<AppConfig, "qmdEmbedModel">): string {
  return config.qmdEmbedModel ?? QMD_DEFAULT_EMBED_MODEL_SENTINEL;
}

export interface QmdStatus {
  totalDocuments: number;
  needsEmbedding: number;
  hasVectorIndex: boolean;
  collections: Array<{
    name: string;
    path: string | null;
    pattern: string | null;
    documents: number;
    lastUpdated: string;
  }>;
}

export interface QmdEmbedOptions {
  force?: boolean;
}

export interface QmdOrphanCleanupResult {
  deletedInactiveDocuments: number;
  cleanedOrphanedContent: number;
  cleanedOrphanedVectors: number;
}

export interface QmdClient {
  search(options: {
    query?: string;
    queries?: ExpandedQuery[];
    limit?: number;
    rerank?: boolean;
    minScore?: number;
  }): Promise<HybridQueryResult[]>;
  searchLex(query: string, options?: { limit?: number }): Promise<
    Array<{
      filepath: string;
      displayPath: string;
      title: string;
      body?: string;
      score: number;
      docid: string;
      context: string | null;
    }>
  >;
  update(): Promise<unknown>;
  embed(options?: QmdEmbedOptions): Promise<unknown>;
  getStatus(): Promise<QmdStatus>;
  listContexts(): Promise<Array<{ collection: string; path: string; context: string }>>;
  addContext(collectionName: string, pathPrefix: string, contextText: string): Promise<boolean>;
  removeContext(collectionName: string, pathPrefix: string): Promise<boolean>;
  // Reclaim rows left behind when documents disappear from the filesystem
  // scan (qmd.update flags them active=0 but never deletes) and the vectors
  // that were attached to those now-dead content hashes. qmd.update calls
  // cleanupOrphanedContent but not cleanupOrphanedVectors, so without this
  // every removal or content-hash change leaks vector rows indefinitely.
  cleanupOrphans(): Promise<QmdOrphanCleanupResult>;
  close(): Promise<void>;
}

export type QmdFactory = (config: AppConfig) => Promise<QmdClient>;

export function applyQmdRuntimeEnv(
  config: AppConfig,
  options: {
    env?: NodeJS.ProcessEnv;
  } = {},
): void {
  const env = options.env ?? process.env;

  if (config.qmdEmbedModel) {
    env.QMD_EMBED_MODEL = config.qmdEmbedModel;
  }
}

function wrapStore(store: QMDStore): QmdClient {
  return {
    search: (options) =>
      store.search({
        query: options.query,
        queries: options.queries,
        limit: options.limit,
        rerank: options.rerank,
        minScore: options.minScore,
      }),
    searchLex: (query, options) => store.searchLex(query, options),
    update: () => store.update(),
    embed: (options) => store.embed(options),
    getStatus: () => store.getStatus(),
    listContexts: () => store.listContexts(),
    addContext: (collectionName, pathPrefix, contextText) =>
      store.addContext(collectionName, pathPrefix, contextText),
    removeContext: (collectionName, pathPrefix) => store.removeContext(collectionName, pathPrefix),
    cleanupOrphans: async () => ({
      deletedInactiveDocuments: store.internal.deleteInactiveDocuments(),
      cleanedOrphanedContent: store.internal.cleanupOrphanedContent(),
      cleanedOrphanedVectors: store.internal.cleanupOrphanedVectors(),
    }),
    close: () => store.close(),
  };
}

export async function openQmdClient(config: AppConfig): Promise<QmdClient> {
  const paths = getDataPaths(config.dataDir);
  ensureDir(paths.normalizedDir);
  ensureDir(paths.indexDir);

  applyQmdRuntimeEnv(config);

  const { createStore } = await import("@tobilu/qmd");
  const store = await createStore({
    dbPath: paths.qmdDbPath,
    config: {
      collections: {
        library: {
          path: paths.normalizedDir,
          pattern: "**/*.md",
        },
      },
    },
  });

  return wrapStore(store);
}
