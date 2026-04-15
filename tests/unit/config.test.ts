import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { getDataPaths } from "../../src/config.js";

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
    paths.exactDbPath,
    "/Users/example/Library/Mobile Documents/com~apple~CloudDocs/Zotagent/index/exact.sqlite",
  );
  assert.equal(paths.tempDir, resolve(tmpdir(), "zotagent"));
});
