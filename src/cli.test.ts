import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const cliPath = new URL("./cli.ts", import.meta.url).pathname;

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    encoding: "utf-8",
    cwd: new URL(".", import.meta.url).pathname,
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test("help summarizes current commands and keeps config-only overrides out of the main listing", () => {
  const result = runCli(["help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /zotlit sync \[--attachments-root <path>\]/);
  assert.match(result.stdout, /zotlit search "<text>" \[--exact\] \[--limit <n>\]/);
  assert.match(result.stdout, /Options:/);
  assert.match(result.stdout, /--limit <n>\s+Return up to n search results\. Default: 10\./);
  assert.match(result.stdout, /expand currently requires --file\./);
  assert.match(result.stdout, /Paths and other defaults are read from \~\/\.zotlit\/config\.json\./);
  assert.doesNotMatch(result.stdout, /--bibliography <path>/);
  assert.doesNotMatch(result.stdout, /--data-dir <path>/);
  assert.doesNotMatch(result.stdout, /--qmd-embed-model <uri>/);
});

test("sync rejects unexpected positional path and points to attachments-root", () => {
  const result = runCli(["sync", "/tmp/papers"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(result.stdout, /Use --attachments-root/);
});

test("search rejects removed query flag and points to positional usage", () => {
  const result = runCli(["search", "--query", "aging in China"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(result.stdout, /`--query` has been removed/);
  assert.match(result.stdout, /zotlit search .*<text>.*/);
});

test("search rejects combining exact mode with rerank", () => {
  const result = runCli(["search", "--exact", "dangwei shuji", "--rerank"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(result.stdout, /`--exact` cannot be combined with `--rerank`/);
});
