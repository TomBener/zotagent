import type { ExpandedQuery, HybridQueryResult, QMDStore } from "@tobilu/qmd";

import { getDataPaths } from "./config.js";
import type { AppConfig } from "./types.js";
import { ensureDir } from "./utils.js";

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
  embed(): Promise<unknown>;
  getStatus(): Promise<QmdStatus>;
  listContexts(): Promise<Array<{ collection: string; path: string; context: string }>>;
  addContext(collectionName: string, pathPrefix: string, contextText: string): Promise<boolean>;
  removeContext(collectionName: string, pathPrefix: string): Promise<boolean>;
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
    embed: () => store.embed(),
    getStatus: () => store.getStatus(),
    listContexts: () => store.listContexts(),
    addContext: (collectionName, pathPrefix, contextText) =>
      store.addContext(collectionName, pathPrefix, contextText),
    removeContext: (collectionName, pathPrefix) => store.removeContext(collectionName, pathPrefix),
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
