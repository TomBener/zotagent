import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { getDataPaths } from "../../src/config.js";

test("getDataPaths keeps index outputs in dataDir but uses system temp for extraction work", () => {
  const paths = getDataPaths("/Users/example/Library/Mobile Documents/com~apple~CloudDocs/Zotlit");

  assert.equal(
    paths.logsDir,
    "/Users/example/Library/Mobile Documents/com~apple~CloudDocs/Zotlit/logs",
  );
  assert.equal(
    paths.latestSyncLogPath,
    "/Users/example/Library/Mobile Documents/com~apple~CloudDocs/Zotlit/logs/sync-latest.log",
  );
  assert.equal(
    paths.normalizedDir,
    "/Users/example/Library/Mobile Documents/com~apple~CloudDocs/Zotlit/normalized",
  );
  assert.equal(
    paths.manifestsDir,
    "/Users/example/Library/Mobile Documents/com~apple~CloudDocs/Zotlit/manifests",
  );
  assert.equal(
    paths.indexDir,
    "/Users/example/Library/Mobile Documents/com~apple~CloudDocs/Zotlit/index",
  );
  assert.equal(
    paths.tantivyDir,
    "/Users/example/Library/Mobile Documents/com~apple~CloudDocs/Zotlit/index/tantivy",
  );
  assert.equal(paths.tempDir, resolve(tmpdir(), "zotlit"));
});
