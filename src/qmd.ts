import type { ExpandedQuery, HybridQueryResult, QMDStore } from "@tobilu/qmd";
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getDataPaths } from "./config.js";
import type { AppConfig } from "./types.js";
import { ensureDir } from "./utils.js";

const QMD_PACKAGE_ENTRY = fileURLToPath(import.meta.resolve("@tobilu/qmd"));
const QMD_PACKAGE_JSON_PATH = resolve(dirname(QMD_PACKAGE_ENTRY), "..", "package.json");
// qmd ships maybeAdoptLegacyEmbeddingFingerprint inside its internal store.js
// (only the `qmd doctor` CLI calls it). The package `exports` field doesn't
// re-export it, so we resolve the file path and dynamic-import a file URL —
// that path bypasses `exports` (per Node ESM spec) without monkey-patching
// the package. Replace with a normal named import once qmd exposes the helper
// from its root.
const QMD_INTERNAL_STORE_URL = pathToFileURL(
  resolve(dirname(QMD_PACKAGE_ENTRY), "store.js"),
).href;

function readPackageVersion(path: string): string {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown };
  return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "unknown";
}

export const QMD_PACKAGE_VERSION = readPackageVersion(QMD_PACKAGE_JSON_PATH);

// Sentinel recorded on the catalog when the user has not pinned a model. The
// real default lives inside `@tobilu/qmd` and is not part of its public API.
// A full re-embed is only triggered when this resolved model string changes;
// qmd package upgrades no longer auto-clear embeddings, so users who care
// about default-drift should pin `qmdEmbedModel` explicitly.
export const QMD_DEFAULT_EMBED_MODEL_SENTINEL = "qmd-default";

export function resolveQmdEmbedModel(config: Pick<AppConfig, "qmdEmbedModel">): string {
  return config.qmdEmbedModel ?? QMD_DEFAULT_EMBED_MODEL_SENTINEL;
}

// content_vectors.model values qmd used to write before 2.5.0 switched to the
// full hf: URI. When a user upgrades qmd, the new code can't see vectors stored
// under the old alias and would otherwise re-embed the entire library. Append
// new entries here as future qmd model-identity changes appear; the migration
// is a pure SQL rename — safe because qmd's hf URI and chunk/format parameters
// are unchanged on these renames.
const LEGACY_QMD_MODEL_ALIASES: ReadonlyArray<readonly [legacy: string, current: string]> = [
  ["embeddinggemma", "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf"],
];

export interface QmdAliasMigrationResult {
  updated: number;
  conflicts: number;
}

export interface QmdLegacyAdoptionResult {
  adopted: number;
  checked: boolean;
  reason: string;
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
  clearEmbeddings(): Promise<void>;
  // Reclaim rows left behind when documents disappear from the filesystem
  // scan (qmd.update flags them active=0 but never deletes) and the vectors
  // that were attached to those now-dead content hashes. qmd.update calls
  // cleanupOrphanedContent but not cleanupOrphanedVectors, so without this
  // every removal or content-hash change leaks vector rows indefinitely.
  cleanupOrphans(): Promise<QmdOrphanCleanupResult>;
  // Rename rows in content_vectors whose model column matches a known qmd
  // legacy alias to the current canonical URI. Run before adoptLegacyEmbeddings
  // so qmd's own sample-verify path can find the rows.
  migrateLegacyModelAliases(): Promise<QmdAliasMigrationResult>;
  // Sample-verify and adopt content_vectors rows that were embedded under the
  // current model/format but predate the embed_fingerprint column qmd 2.5.0
  // added. Cheap no-op when nothing legacy is present.
  adoptLegacyEmbeddings(): Promise<QmdLegacyAdoptionResult>;
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

type QmdInternalAdoptFn = (
  store: unknown,
  model?: string,
) => Promise<{ checked?: boolean; adopted?: number; reason?: string }>;

let cachedAdoptFn: QmdInternalAdoptFn | null = null;

async function loadQmdAdoptFn(): Promise<QmdInternalAdoptFn> {
  if (cachedAdoptFn) return cachedAdoptFn;
  const mod = (await import(QMD_INTERNAL_STORE_URL)) as {
    maybeAdoptLegacyEmbeddingFingerprint?: QmdInternalAdoptFn;
  };
  if (typeof mod.maybeAdoptLegacyEmbeddingFingerprint !== "function") {
    throw new Error(
      `@tobilu/qmd ${QMD_PACKAGE_VERSION} does not expose maybeAdoptLegacyEmbeddingFingerprint; needs >= 2.5.0`,
    );
  }
  cachedAdoptFn = mod.maybeAdoptLegacyEmbeddingFingerprint;
  return cachedAdoptFn;
}

function getStoreDb(store: QMDStore): Database.Database {
  // store.internal.db is the raw better-sqlite3 handle qmd uses for everything;
  // expose it through this typed accessor so the cast stays in one place.
  return (store.internal as unknown as { db: Database.Database }).db;
}

function migrateAliases(db: Database.Database): QmdAliasMigrationResult {
  let updated = 0;
  let conflicts = 0;
  // PK is (hash, seq); the same chunk position written under both names would
  // clash on UPDATE. The "current" row was written by the new code path and is
  // what we want to keep, so drop the legacy half before the rename.
  const dropConflictsStmt = db.prepare(
    `DELETE FROM content_vectors
     WHERE model = ?
       AND (hash, seq) IN (SELECT hash, seq FROM content_vectors WHERE model = ?)`,
  );
  const renameStmt = db.prepare(`UPDATE content_vectors SET model = ? WHERE model = ?`);
  const tx = db.transaction(() => {
    for (const [legacy, current] of LEGACY_QMD_MODEL_ALIASES) {
      conflicts += dropConflictsStmt.run(legacy, current).changes;
      updated += renameStmt.run(current, legacy).changes;
    }
  });
  tx();
  return { updated, conflicts };
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
    clearEmbeddings: async () => {
      store.internal.clearAllEmbeddings();
    },
    cleanupOrphans: async () => ({
      deletedInactiveDocuments: store.internal.deleteInactiveDocuments(),
      cleanedOrphanedContent: store.internal.cleanupOrphanedContent(),
      cleanedOrphanedVectors: store.internal.cleanupOrphanedVectors(),
    }),
    migrateLegacyModelAliases: async () => migrateAliases(getStoreDb(store)),
    adoptLegacyEmbeddings: async () => {
      const fn = await loadQmdAdoptFn();
      const result = await fn(store.internal);
      return {
        adopted: typeof result.adopted === "number" ? result.adopted : 0,
        checked: Boolean(result.checked),
        reason: typeof result.reason === "string" ? result.reason : "",
      };
    },
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
