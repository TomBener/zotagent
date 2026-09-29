import test from "node:test";
import assert from "node:assert/strict";

import { applyQmdRuntimeEnv, EMBED_PROBE_MIN_SIMILARITY, embeddingProbeSimilarity, encodeEmbeddingProbe } from "../../src/qmd.js";
import type { AppConfig } from "../../src/types.js";

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    bibliographyJsonPath: "/tmp/bibliography.json",
    attachmentsRoot: "/tmp/attachments",
    dataDir: "/tmp/data",
    warnings: [],
    ...overrides,
  };
}

test("applyQmdRuntimeEnv preserves existing node-llama-cpp GPU setting", () => {
  const env: NodeJS.ProcessEnv = { NODE_LLAMA_CPP_GPU: "metal" };

  applyQmdRuntimeEnv(createConfig(), { env });

  assert.equal(env.NODE_LLAMA_CPP_GPU, "metal");
});

test("applyQmdRuntimeEnv leaves GPU setting unchanged when no embed override is provided", () => {
  const env: NodeJS.ProcessEnv = {};

  applyQmdRuntimeEnv(createConfig(), { env });

  assert.equal(env.NODE_LLAMA_CPP_GPU, undefined);
});

test("applyQmdRuntimeEnv forwards qmdEmbedModel into runtime env", () => {
  const env: NodeJS.ProcessEnv = {};

  applyQmdRuntimeEnv(
    createConfig({ qmdEmbedModel: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf" }),
    { env },
  );

  assert.equal(
    env.QMD_EMBED_MODEL,
    "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
  );
  assert.equal(env.NODE_LLAMA_CPP_GPU, undefined);
});

test("embedding probes compare by cosine similarity and reject shape mismatches", () => {
  const probe = encodeEmbeddingProbe([0.25, -1.5, 3, 0]);
  assert.equal(embeddingProbeSimilarity(probe, probe), 1);
  // Scale does not matter; direction does.
  assert.ok(embeddingProbeSimilarity(probe, encodeEmbeddingProbe([0.5, -3, 6, 0])) > 0.9999);
  assert.equal(embeddingProbeSimilarity(encodeEmbeddingProbe([1, 0]), encodeEmbeddingProbe([0, 1])), 0);
  assert.ok(embeddingProbeSimilarity(probe, encodeEmbeddingProbe([0.25, -1.5, 3.05, 0])) >= EMBED_PROBE_MIN_SIMILARITY);
  // A probe of another dimension (another model) or a zero vector never matches.
  assert.equal(embeddingProbeSimilarity(probe, encodeEmbeddingProbe([0.25, -1.5, 3])), 0);
  assert.equal(embeddingProbeSimilarity(probe, encodeEmbeddingProbe([0, 0, 0, 0])), 0);
});
