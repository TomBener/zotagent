import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

// Resolve config against a throwaway ~/.zotagent/config.json.
function withConfigFile<T>(contents: unknown, env: Record<string, string | undefined>, fn: () => T): T {
  const home = mkdtempSync(join(tmpdir(), "zotagent-config-home-"));
  mkdirSync(join(home, ".zotagent"));
  writeFileSync(join(home, ".zotagent", "config.json"), JSON.stringify(contents));
  const saved = { HOME: process.env.HOME, ...Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]])) };
  process.env.HOME = home;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

const NO_SYNC_ENV = { ZOTAGENT_SYNC_ENABLED: undefined };

test("resolveConfig accepts a numeric zoteroLibraryId", () => {
  const config = withConfigFile(
    { zoteroLibraryId: 6354609 },
    { ZOTAGENT_ZOTERO_LIBRARY_ID: undefined, ZOTERO_LIBRARY_ID: undefined },
    () => resolveConfig(),
  );
  assert.equal(config.zoteroLibraryId, "6354609");
});

test("resolveConfig reads syncEnabled booleans and boolean-like strings", () => {
  for (const [raw, want] of [[false, false], [true, true], ["false", false], ["off", false], ["yes", true]] as const) {
    const config = withConfigFile({ syncEnabled: raw }, NO_SYNC_ENV, () => resolveConfig());
    assert.equal(config.syncEnabled, want, `syncEnabled: ${JSON.stringify(raw)}`);
    assert.deepEqual(config.warnings, []);
  }
  assert.equal(withConfigFile({}, NO_SYNC_ENV, () => resolveConfig()).syncEnabled, undefined);
});

test("resolveConfig fails closed on an unreadable syncEnabled", () => {
  // The guard exists to keep read-only hosts from syncing; a value that was
  // meant to set it must never leave sync enabled.
  const fromFile = withConfigFile({ syncEnabled: "nope" }, NO_SYNC_ENV, () => resolveConfig());
  assert.equal(fromFile.syncEnabled, false);
  assert.match(fromFile.warnings.join("\n"), /syncEnabled.*Treating sync as disabled/u);

  const fromEnv = withConfigFile({ syncEnabled: true }, { ZOTAGENT_SYNC_ENABLED: "disable" }, () => resolveConfig());
  assert.equal(fromEnv.syncEnabled, false);
  assert.match(fromEnv.warnings.join("\n"), /ZOTAGENT_SYNC_ENABLED.*Treating sync as disabled/u);

  const offEnv = withConfigFile({ syncEnabled: true }, { ZOTAGENT_SYNC_ENABLED: "off" }, () => resolveConfig());
  assert.equal(offEnv.syncEnabled, false);
});
