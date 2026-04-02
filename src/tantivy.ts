import { readFileSync, rmSync } from "node:fs";

import { getDataPaths } from "./config.js";
import { buildExactIndexText, buildExactManifestBody, normalizeExactText } from "./exact.js";
import type { AppConfig, AttachmentManifest, CatalogEntry } from "./types.js";
import { ensureDir, exists } from "./utils.js";

const DOC_KEY_FIELD = "docKey";
const TITLE_FIELD = "title";
const BODY_FIELD = "body";
const RAW_TOKENIZER = "zotlit_raw";
const NGRAM_TOKENIZER = "zotlit_ngram";
const EXACT_MIN_GRAM = 2;
const EXACT_MAX_GRAM = 3;
const MIN_CANDIDATES = 20;
const CANDIDATE_LIMIT_MULTIPLIER = 5;

type TantivyModule = typeof import("@pngwasi/node-tantivy-binding");
type TantivyIndex = InstanceType<TantivyModule["Index"]>;

export interface ExactSearchCandidate {
  docKey: string;
  score: number;
}

export interface ExactIndexClient {
  rebuildExactIndex(readyEntries: CatalogEntry[]): Promise<void>;
  searchExactCandidates(query: string, limit: number): Promise<ExactSearchCandidate[]>;
  close(): Promise<void>;
}

export type ExactIndexFactory = (config: AppConfig) => Promise<ExactIndexClient>;

function readManifest(path: string): AttachmentManifest {
  return JSON.parse(readFileSync(path, "utf-8")) as AttachmentManifest;
}

async function loadTantivy(): Promise<TantivyModule> {
  return await import("@pngwasi/node-tantivy-binding");
}

function createExactSchema(tantivy: TantivyModule): InstanceType<TantivyModule["Schema"]> {
  return new tantivy.SchemaBuilder()
    .addTextField(DOC_KEY_FIELD, {
      stored: true,
      tokenizerName: RAW_TOKENIZER,
      indexOption: "basic",
    })
    .addTextField(TITLE_FIELD, {
      tokenizerName: NGRAM_TOKENIZER,
    })
    .addTextField(BODY_FIELD, {
      tokenizerName: NGRAM_TOKENIZER,
    })
    .build();
}

function registerExactTokenizers(index: TantivyIndex, tantivy: TantivyModule): void {
  index.registerTokenizer(
    RAW_TOKENIZER,
    new tantivy.TextAnalyzerBuilder(tantivy.TokenizerStatic.raw()).build(),
  );
  index.registerTokenizer(
    NGRAM_TOKENIZER,
    new tantivy.TextAnalyzerBuilder(
      tantivy.TokenizerStatic.ngram(EXACT_MIN_GRAM, EXACT_MAX_GRAM, false),
    )
      .filter(tantivy.FilterStatic.lowercase())
      .build(),
  );
}

function readStoredDocKey(document: { toDict(): object }): string | undefined {
  const dict = document.toDict() as Record<string, unknown>;
  const raw = dict[DOC_KEY_FIELD];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const first = raw[0];
  return typeof first === "string" && first.length > 0 ? first : undefined;
}

function openExistingIndex(paths: ReturnType<typeof getDataPaths>, tantivy: TantivyModule): TantivyIndex {
  if (!tantivy.Index.exists(paths.tantivyDir)) {
    throw new Error("Exact index not found. Run `zotlit sync` first.");
  }
  const index = tantivy.Index.open(paths.tantivyDir);
  registerExactTokenizers(index, tantivy);
  return index;
}

export async function openExactIndex(config: AppConfig): Promise<ExactIndexClient> {
  const paths = getDataPaths(config.dataDir);
  ensureDir(paths.indexDir);
  const tantivy = await loadTantivy();

  return {
    rebuildExactIndex: async (readyEntries) => {
      rmSync(paths.tantivyDir, { recursive: true, force: true });
      ensureDir(paths.tantivyDir);

      const index = new tantivy.Index(createExactSchema(tantivy), paths.tantivyDir, false);
      registerExactTokenizers(index, tantivy);

      const writer = index.writer();
      for (const entry of readyEntries) {
        if (!entry.manifestPath || !exists(entry.manifestPath)) continue;

        const manifest = readManifest(entry.manifestPath);
        const document = new tantivy.Document();
        document.addText(DOC_KEY_FIELD, entry.docKey);

        const title = buildExactIndexText([entry.title]);
        const body = buildExactManifestBody(manifest);
        if (title.length > 0) {
          document.addText(TITLE_FIELD, title);
        }
        if (body.length > 0) {
          document.addText(BODY_FIELD, body);
        }

        writer.addDocument(document);
      }

      writer.commit();
      index.reload();
    },

    searchExactCandidates: async (query, limit) => {
      const normalizedQuery = normalizeExactText(query);
      if (normalizedQuery.length === 0) {
        throw new Error("Exact search text cannot be empty.");
      }

      const index = openExistingIndex(paths, tantivy);
      const parsedQuery = index.parseQuery(normalizedQuery, [TITLE_FIELD, BODY_FIELD]);
      const searcher = index.searcher();
      const candidateLimit = Math.max(limit * CANDIDATE_LIMIT_MULTIPLIER, MIN_CANDIDATES);
      const results = searcher.search(parsedQuery, candidateLimit, true);

      return results.hits
        .map((hit) => {
          const docKey = readStoredDocKey(searcher.doc(hit.docAddress));
          if (!docKey) return null;
          return {
            docKey,
            score: hit.score,
          };
        })
        .filter((candidate): candidate is ExactSearchCandidate => candidate !== null);
    },

    close: async () => {},
  };
}
