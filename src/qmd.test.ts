import test from "node:test";
import assert from "node:assert/strict";

import { applyQmdRuntimeEnv } from "./qmd.js";
import type { AppConfig } from "./types.js";

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
