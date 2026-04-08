import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("../..", import.meta.url);
const cliPath = new URL("../../src/cli.ts", import.meta.url).pathname;
const expectedVersion = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
) as { version: string };

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    encoding: "utf-8",
    cwd: repoRoot.pathname,
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
  assert.match(
    result.stdout,
    /zotlit sync \[--attachments-root <path>\] \[--retry-errors\] \[--pdf-timeout-ms <n>\] \[--pdf-batch-size <n>\]/,
  );
  assert.match(result.stdout, /zotlit version/);
  assert.match(result.stdout, /zotlit add \[--doi <doi> \| --s2-paper-id <id>\] \[--title <text>\]/);
  assert.match(result.stdout, /zotlit s2 "<text>" \[--limit <n>\]/);
  assert.match(result.stdout, /zotlit search "<text>" \[--exact\] \[--limit <n>\]/);
  assert.match(result.stdout, /zotlit metadata "<text>" \[--limit <n>\] \[--field <field>\] \[--has-pdf\]/);
  assert.match(result.stdout, /Options:/);
  assert.match(result.stdout, /--doi <doi>\s+Import from DOI metadata when possible\./);
  assert.match(result.stdout, /--s2-paper-id <id>\s+Import a Semantic Scholar paper by paperId\./);
  assert.match(result.stdout, /--collection-key <key>\s+Add the new item to a Zotero collection by collection key\./);
  assert.match(result.stdout, /--item-type <type>\s+Override the Zotero item type\./);
  assert.match(result.stdout, /--version\s+Print the current zotlit version\./);
  assert.match(result.stdout, /--retry-errors\s+Retry unchanged PDFs that failed extraction earlier\./);
  assert.match(result.stdout, /--pdf-timeout-ms <n>\s+Override the OpenDataLoader timeout/);
  assert.match(result.stdout, /--pdf-batch-size <n>\s+Override the maximum number of PDFs per extraction batch\./);
  assert.match(
    result.stdout,
    /--limit <n>\s+Return up to n search results\. Default: 10 for search, 20 for metadata\./,
  );
  assert.match(result.stdout, /qmd reranking is skipped by default/);
  assert.match(result.stdout, /--rerank\s+Enable qmd reranking/);
  assert.match(result.stdout, /--field <field>\s+Limit metadata search/);
  assert.match(result.stdout, /--has-pdf\s+Keep only metadata results/);
  assert.match(result.stdout, /expand currently requires --file\./);
  assert.match(result.stdout, /zoteroLibraryType supports both user and group\./);
  assert.match(result.stdout, /zoteroCollectionKey sets the default collection/);
  assert.match(result.stdout, /Paths and other defaults are read from \~\/\.zotlit\/config\.json\./);
  assert.doesNotMatch(result.stdout, /--bibliography <path>/);
  assert.doesNotMatch(result.stdout, /--data-dir <path>/);
  assert.doesNotMatch(result.stdout, /--qmd-embed-model <uri>/);
});

test("version prints the current package version", () => {
  const result = runCli(["version"]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), expectedVersion.version);
});

test("--version prints the current package version", () => {
  const result = runCli(["--version"]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), expectedVersion.version);
});

test("sync rejects unexpected positional path and points to attachments-root", () => {
  const result = runCli(["sync", "/tmp/papers"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(result.stdout, /Use --attachments-root/);
});

test("sync rejects invalid pdf timeout", () => {
  const result = runCli(["sync", "--pdf-timeout-ms", "0"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "INVALID_ARGUMENT"/);
  assert.match(result.stdout, /`--pdf-timeout-ms` must be a positive integer\./);
});

test("sync rejects invalid pdf batch size", () => {
  const result = runCli(["sync", "--pdf-batch-size", "0"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "INVALID_ARGUMENT"/);
  assert.match(result.stdout, /`--pdf-batch-size` must be a positive integer\./);
});

test("add requires doi or title", () => {
  const result = runCli(["add"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "MISSING_ARGUMENT"/);
  assert.match(result.stdout, /Provide --doi <doi>, --s2-paper-id <id>, or --title <text> for add\./);
});

test("add rejects positional arguments", () => {
  const result = runCli(["add", "10.1000/test"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(result.stdout, /add does not accept positional arguments/);
});

test("add rejects combining doi and s2-paper-id", () => {
  const result = runCli(["add", "--doi", "10.1000/test", "--s2-paper-id", "paper-1"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(result.stdout, /Use either --doi <doi> or --s2-paper-id <id>, not both\./);
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

test("metadata rejects removed query flag and points to positional usage", () => {
  const result = runCli(["metadata", "--query", "aging in China"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(result.stdout, /`--query` is not supported/);
  assert.match(result.stdout, /zotlit metadata .*<text>.*/);
});

test("metadata rejects search-only flags", () => {
  const result = runCli(["metadata", "--exact", "aging in China"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(result.stdout, /metadata only supports --limit, --field, and --has-pdf/);
});

test("s2 rejects metadata and search-only flags", () => {
  const result = runCli(["s2", "--field", "title", "aging in China"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(result.stdout, /s2 only supports --limit/);
});

test("metadata accumulates repeated field filters", () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-cli-metadata-"));
  const attachmentsRoot = join(root, "attachments");
  mkdirSync(attachmentsRoot, { recursive: true });
  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        title: "Needle in title",
        author: [{ family: "Smith", given: "Jane" }],
        issued: { "date-parts": [[2024]] },
        type: "book",
        "zotero-item-key": "ITEM1",
      },
      {
        title: "Other title",
        abstract: "Needle in abstract",
        author: [{ family: "Doe", given: "John" }],
        issued: { "date-parts": [[2023]] },
        type: "book",
        "zotero-item-key": "ITEM2",
      },
    ]),
    "utf-8",
  );

  const result = runCli([
    "metadata",
    "needle",
    "--field",
    "title",
    "--field",
    "abstract",
    "--bibliography",
    bibliographyPath,
    "--attachments-root",
    attachmentsRoot,
    "--data-dir",
    join(root, "data"),
  ]);

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    data: {
      results: Array<{ itemKey: string }>;
    };
  };
  assert.equal(parsed.ok, true);
  assert.deepEqual(
    parsed.data.results.map((row) => row.itemKey),
    ["ITEM1", "ITEM2"],
  );
});
