import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { getDataPaths, resolveConfig } from "../../src/config.js";

test("getDataPaths keeps index outputs in dataDir but uses system temp for extraction work", () => {
  const paths = getDataPaths("/Users/example/Library/Mobile Documents/com~apple~CloudDocs/Zotagent");

  assert.equal(
    paths.logsDir,
    "/Users/example/Library/Mobile Documents/com~apple~CloudDocs/Zotagent/logs",
  );
  assert.equal(
    paths.latestSyncLogPath,
    "/Users/example/Library/Mobile Documents/com~apple~CloudDocs/Zotagent/logs/sync-latest.log",
  );
  assert.equal(
    paths.normalizedDir,
    "/Users/example/Library/Mobile Documents/com~apple~CloudDocs/Zotagent/normalized",
  );
  assert.equal(
    paths.manifestsDir,
    "/Users/example/Library/Mobile Documents/com~apple~CloudDocs/Zotagent/manifests",
  );
  assert.equal(
    paths.indexDir,
    "/Users/example/Library/Mobile Documents/com~apple~CloudDocs/Zotagent/index",
  );
  assert.equal(
    paths.keywordDbPath,
    "/Users/example/Library/Mobile Documents/com~apple~CloudDocs/Zotagent/index/keyword.sqlite",
  );
  assert.equal(paths.tempDir, resolve(tmpdir(), "zotagent"));
});

// translationServerUrl resolution. An explicit override has top priority and
// bypasses the env var / config file, so these assertions are stable on a
// developer machine that has a server configured for real use.
test("resolveConfig strips a trailing slash from translationServerUrl", () => {
  const config = resolveConfig({ translationServerUrl: "http://127.0.0.1:1969/" });
  assert.equal(config.translationServerUrl, "http://127.0.0.1:1969");
  assert.equal(
    config.warnings.some((warning) => warning.includes("translationServerUrl")),
    false,
  );
});

test("resolveConfig rejects a non-http translationServerUrl with a warning", () => {
  const config = resolveConfig({ translationServerUrl: "127.0.0.1:1969" });
  assert.equal(config.translationServerUrl, undefined);
  assert.equal(
    config.warnings.some((warning) => warning.includes("translationServerUrl")),
    true,
  );
});

test("resolveConfig treats an empty translationServerUrl override as disabled", () => {
  const config = resolveConfig({ translationServerUrl: "" });
  assert.equal(config.translationServerUrl, undefined);
  assert.equal(
    config.warnings.some((warning) => warning.includes("translationServerUrl")),
    false,
  );
});
