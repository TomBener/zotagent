import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeConfigFile } from "../../src/config-command.js";

function tempConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "zotagent-config-"));
  // Nest under a not-yet-created subdirectory to exercise mkdir + its mode.
  return join(dir, "nested", "config.json");
}

test("writeConfigFile creates parent dir and writes owner-only modes", () => {
  const path = tempConfigPath();
  const config = { zoteroApiKey: "secret", zoteroLibraryId: "12345" };

  writeConfigFile(path, config);

  assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), config);
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
  }
});

test("writeConfigFile tightens an existing world-readable file", () => {
  const path = tempConfigPath();
  // Pre-create it world-readable, defeating umask with an explicit chmod.
  writeConfigFile(path, {});
  writeFileSync(path, "{}", { mode: 0o644 });
  chmodSync(path, 0o644);

  writeConfigFile(path, { semanticScholarApiKey: "s2key" });

  assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), { semanticScholarApiKey: "s2key" });
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
});

test("writeConfigFile writes pretty-printed JSON with a trailing newline", () => {
  const path = tempConfigPath();
  const config = { a: 1, b: "two" };

  writeConfigFile(path, config);

  assert.equal(readFileSync(path, "utf-8"), `${JSON.stringify(config, null, 2)}\n`);
});
