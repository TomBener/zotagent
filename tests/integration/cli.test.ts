import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { openKeywordIndex } from "../../src/keyword-db.js";
import { writeCatalogFile } from "../../src/state.js";
import type { AppConfig, AttachmentManifest, CatalogEntry, CatalogFile } from "../../src/types.js";
import { MANIFEST_EXT, writeManifestFile } from "../../src/utils.js";

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

function writeManifest(path: string, manifest: AttachmentManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeManifestFile(path, manifest);
}

function createConfig(bibliographyJsonPath: string, attachmentsRoot: string, dataDir: string): AppConfig {
  return {
    bibliographyJsonPath,
    attachmentsRoot,
    dataDir,
    warnings: [],
  };
}

function readyEntry(
  dataDir: string,
  docKey: string,
  itemKey: string,
  citationKey: string,
  title: string,
  filePath: string,
  manifestPath: string,
): CatalogEntry {
  return {
    docKey,
    itemKey,
    citationKey,
    title,
    authors: ["A"],
    filePath,
    fileExt: "pdf",
    exists: true,
    supported: true,
    extractStatus: "ready",
    size: 1,
    mtimeMs: 1,
    sourceHash: `${docKey}-hash`,
    lastIndexedAt: new Date().toISOString(),
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
    manifestPath,
  };
}

async function createIndexedFixture(): Promise<{
  root: string;
  bibliographyPath: string;
  attachmentsRoot: string;
  dataDir: string;
  docKey: string;
  filePath: string;
  manifestPath: string;
  citationKey: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "zotagent-cli-indexed-"));
  const attachmentsRoot = join(root, "attachments");
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  const normalizedDir = join(dataDir, "normalized");
  const bibliographyPath = join(root, "bibliography.json");
  const docKey = "9".repeat(40);
  const filePath = join(attachmentsRoot, "paper.pdf");
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  const normalizedPath = join(normalizedDir, `${docKey}.md`);
  const citationKey = "lee2024party";

  mkdirSync(attachmentsRoot, { recursive: true });
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });
  mkdirSync(normalizedDir, { recursive: true });
  writeFileSync(bibliographyPath, "[]", "utf-8");
  writeFileSync(
    normalizedPath,
    [
      "The top leader is the company party secretary, dangwei shuji.",
      "",
      "Party organization shapes firm governance.",
      "",
      "To cite this article, please use the publisher PDF.",
      "",
      "Party organization shapes firm governance.",
      "",
      "Smith, J. (2022). Ageing in China. Journal of Ageing.",
    ].join("\n"),
    "utf-8",
  );

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEM9000",
    citationKey,
    title: "Exact match",
    authors: ["A"],
    filePath,
    normalizedPath,
    blocks: [
      {
        blockIndex: 0,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "The top leader is the company party secretary, dangwei shuji.",
        charStart: 0,
        charEnd: 63,
        lineStart: 1,
        lineEnd: 1,
        isReferenceLike: false,
      },
      {
        blockIndex: 1,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "Party organization shapes firm governance.",
        charStart: 65,
        charEnd: 106,
        lineStart: 3,
        lineEnd: 3,
        isReferenceLike: false,
      },
      {
        blockIndex: 2,
        blockType: "paragraph",
        sectionPath: ["Front Matter"],
        text: "To cite this article, please use the publisher PDF.",
        charStart: 108,
        charEnd: 161,
        lineStart: 5,
        lineEnd: 5,
        isReferenceLike: false,
      },
      {
        blockIndex: 3,
        blockType: "paragraph",
        sectionPath: ["Body"],
        text: "Party organization shapes firm governance.",
        charStart: 163,
        charEnd: 204,
        lineStart: 7,
        lineEnd: 7,
        isReferenceLike: false,
      },
      {
        blockIndex: 4,
        blockType: "paragraph",
        sectionPath: ["References"],
        text: "Smith, J. (2022). Ageing in China. Journal of Ageing.",
        charStart: 206,
        charEnd: 260,
        lineStart: 9,
        lineEnd: 9,
        isReferenceLike: true,
      },
    ],
  });

  const catalog: CatalogFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [readyEntry(dataDir, docKey, "ITEM9000", citationKey, "Exact match", filePath, manifestPath)],
  };
  writeCatalogFile(join(indexDir, "catalog.json"), catalog);

  const keywordIndex = await openKeywordIndex(createConfig(bibliographyPath, attachmentsRoot, dataDir));
  try {
    await keywordIndex.rebuildIndex(catalog.entries);
  } finally {
    await keywordIndex.close();
  }

  return { root, bibliographyPath, attachmentsRoot, dataDir, docKey, filePath, manifestPath, citationKey };
}

async function createMultiIndexedFixture(): Promise<{
  bibliographyPath: string;
  attachmentsRoot: string;
  dataDir: string;
  citationKey: string;
  filePaths: string[];
}> {
  const root = mkdtempSync(join(tmpdir(), "zotagent-cli-multi-"));
  const attachmentsRoot = join(root, "attachments");
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  const bibliographyPath = join(root, "bibliography.json");
  const citationKey = "lee2024multi";
  const filePaths = [join(attachmentsRoot, "paper-one.pdf"), join(attachmentsRoot, "paper-two.pdf")];
  const docKeys = ["1".repeat(40), "2".repeat(40)];

  mkdirSync(attachmentsRoot, { recursive: true });
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });
  writeFileSync(bibliographyPath, "[]", "utf-8");

  for (const [index, docKey] of docKeys.entries()) {
    const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
    writeManifest(manifestPath, {
      docKey,
      itemKey: "ITEMM000",
      citationKey,
      title: `Multi ${index + 1}`,
      authors: ["A"],
      filePath: filePaths[index]!,
      normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
      blocks: [
        {
          blockIndex: 0,
          blockType: "paragraph",
          sectionPath: ["Body"],
          text: `Unique paragraph ${index + 1}.`,
          charStart: 0,
          charEnd: 19,
          lineStart: 1,
          lineEnd: 1,
          isReferenceLike: false,
        },
      ],
    });
  }

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: docKeys.map((docKey, index) =>
      readyEntry(
        dataDir,
        docKey,
        "ITEMM000",
        citationKey,
        `Multi ${index + 1}`,
        filePaths[index]!,
        join(manifestsDir, `${docKey}${MANIFEST_EXT}`),
      ),
    ),
  });

  return { bibliographyPath, attachmentsRoot, dataDir, citationKey, filePaths };
}

test("help summarizes current commands and keeps config-only overrides out of the main listing", () => {
  const result = runCli(["help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^zotagent — Zotero CLI for AI agents\./m);
  assert.match(result.stdout, /Usage: zotagent <command> \[flags\]/);

  // Command signatures grouped under section headings.
  assert.match(result.stdout, /^Index$/m);
  assert.match(
    result.stdout,
    /sync \[--attachments-root <path>\] \[--retry-errors\] \[--pdf-timeout-ms <n>\] \[--pdf-batch-size <n>\]/,
  );
  assert.match(result.stdout, /^\s+status$/m);
  assert.match(result.stdout, /^Add to Zotero$/m);
  assert.match(result.stdout, /add \[--doi <doi> \| --s2-paper-id <id>\] \[--title <text>\]/);
  assert.match(result.stdout, /s2 "<text>" \[--limit <n>\]/);
  assert.match(result.stdout, /^Search$/m);
  assert.match(result.stdout, /search "<text>" \[--keyword \| --semantic\] \[--limit <n>\] \[--min-score <n>\]/);
  assert.match(
    result.stdout,
    /search-in "<text>" --key <key> \[--limit <n>\]/,
  );
  assert.match(result.stdout, /metadata \["<text>"\] \[--limit <n>\] \[--field <field>\] \[--has-file\]/);
  assert.match(result.stdout, /\[--author <text>\] \[--year <text>\] \[--title <text>\] \[--journal <text>\] \[--publisher <text>\]/);
  assert.match(result.stdout, /^Retrieval$/m);
  assert.match(
    result.stdout,
    /blocks --key <key> \[--offset-block <n>\] \[--limit-blocks <n>\]/,
  );
  assert.match(
    result.stdout,
    /fulltext --key <key> \[--clean\]/,
  );
  assert.match(
    result.stdout,
    /expand --key <key> --block-start <n> \[--block-end <n>\] \[--radius <n>\]/,
  );

  // Per-command flag descriptions live near their command, not in a global Options block.
  assert.doesNotMatch(result.stdout, /^Options:$/m);
  assert.match(result.stdout, /--retry-errors\s+Retry unchanged files that failed extraction earlier\./);
  assert.match(result.stdout, /--pdf-timeout-ms <n>\s+Override the OpenDataLoader timeout/);
  assert.match(result.stdout, /--pdf-batch-size <n>\s+Override the maximum number of PDFs per extraction batch\./);
  assert.match(result.stdout, /--doi <doi>\s+Import from DOI metadata when possible\./);
  assert.match(result.stdout, /--s2-paper-id <id>\s+Import a Semantic Scholar paper by paperId\./);
  assert.match(result.stdout, /--collection-key <key>\s+Add the new item to a Zotero collection by collection key\./);
  assert.match(result.stdout, /--item-type <type>\s+Override the Zotero item type\./);
  assert.match(
    result.stdout,
    /--limit <n>\s+Return up to n search results\. Default: 10 for search, 20 for metadata\./,
  );
  assert.match(result.stdout, /Default is keyword search/);
  assert.match(result.stdout, /--field <field>\s+Limit the positional query to/);
  assert.match(result.stdout, /--has-file\s+Keep only metadata results/);
  assert.match(result.stdout, /--abstract\s+Include the abstract in each result/);
  assert.match(result.stdout, /--clean\s+Apply heuristic cleanup/);

  // Document selector is described once in its own block.
  assert.match(
    result.stdout,
    /^Document selector \(used by search-in, blocks, fulltext, expand\)$/m,
  );
  assert.match(result.stdout, /--key <key>\s+Resolve an item by itemKey or citationKey\./);
  assert.match(result.stdout, /A leading @ is\s+stripped before dispatch/);
  assert.doesNotMatch(result.stdout, /--item-key <key>\s/);
  assert.doesNotMatch(result.stdout, /--citation-key <key>/);

  // Version, help, and config entries are present.
  assert.match(result.stdout, /version, --version\s+Print the current zotagent version\./);
  assert.match(result.stdout, /help, --help\s+Show this help\./);
  assert.match(result.stdout, /^\s+config$/m);
  assert.match(result.stdout, /Interactively set \~\/\.zotagent\/config\.json\./);

  // Examples block was removed; workflows live in the zotagent skill, not here.
  assert.doesNotMatch(result.stdout, /^Examples$/m);

  // Config-only overrides should not appear in user-facing help.
  assert.doesNotMatch(result.stdout, /--bibliography <path>/);
  assert.doesNotMatch(result.stdout, /--data-dir <path>/);
  assert.doesNotMatch(result.stdout, /--qmd-embed-model <uri>/);
});

test("config fails fast when stdin is not a TTY", () => {
  const result = runCli(["config"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "CONFIG_REQUIRES_TTY"/);
  assert.match(result.stdout, /requires an interactive terminal/);
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

test("sync refuses to run when syncEnabled is false", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, "sync"], {
    encoding: "utf-8",
    cwd: repoRoot.pathname,
    env: { ...process.env, ZOTAGENT_SYNC_ENABLED: "false" },
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "SYNC_DISABLED"/);
  assert.match(result.stdout, /sync is disabled on this host/);
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

test("search rejects combining keyword mode with semantic", () => {
  const result = runCli(["search", "--keyword", "--semantic", "dangwei shuji"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(result.stdout, /`--keyword` cannot be combined with `--semantic`/);
});

test("metadata rejects search-only flags", () => {
  const result = runCli(["metadata", "--keyword", "aging in China"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(result.stdout, /metadata only supports --limit, --field, --has-file, --abstract, --author, --year, --title, --journal, --publisher\. Remove: --keyword/);
});

test("s2 rejects metadata and search-only flags", () => {
  const result = runCli(["s2", "--field", "title", "aging in China"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(result.stdout, /s2 only supports --limit/);
});

test("s2 rejects invalid limit values", () => {
  const result = runCli(["s2", "aging in China", "--limit", "0"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "INVALID_ARGUMENT"/);
  assert.match(result.stdout, /`--limit` must be a positive integer\./);
});

test("search rejects invalid limit and min-score values", () => {
  const invalidLimit = runCli(["search", "dangwei shuji", "--limit", "0"]);

  assert.equal(invalidLimit.status, 1);
  assert.match(invalidLimit.stdout, /"code": "INVALID_ARGUMENT"/);
  assert.match(invalidLimit.stdout, /`--limit` must be a positive integer\./);

  const invalidScore = runCli(["search", "dangwei shuji", "--min-score", "nope"]);

  assert.equal(invalidScore.status, 1);
  assert.match(invalidScore.stdout, /"code": "INVALID_ARGUMENT"/);
  assert.match(invalidScore.stdout, /`--min-score` must be a finite number\./);
});

test("search-in requires --key and rejects invalid limit values", () => {
  const missing = runCli(["search-in", "party"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /"code": "MISSING_ARGUMENT"/);
  assert.match(missing.stdout, /Provide --key <key>\./);

  const invalidLimit = runCli(["search-in", "party", "--key", "ITEM1000", "--limit", "0"]);

  assert.equal(invalidLimit.status, 1);
  assert.match(invalidLimit.stdout, /"code": "INVALID_ARGUMENT"/);
  assert.match(invalidLimit.stdout, /`--limit` must be a positive integer\./);
});

test("metadata rejects invalid limit values", () => {
  const result = runCli(["metadata", "aging in China", "--limit"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "INVALID_ARGUMENT"/);
  assert.match(result.stdout, /`--limit` requires a positive integer\./);
});

test("blocks requires --key and rejects invalid numeric values", () => {
  const missing = runCli(["blocks"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /"code": "MISSING_ARGUMENT"/);
  assert.match(missing.stdout, /Provide --key <key>\./);

  const invalidOffset = runCli(["blocks", "--key", "ITEM1000", "--offset-block", "-1"]);

  assert.equal(invalidOffset.status, 1);
  assert.match(invalidOffset.stdout, /"code": "INVALID_ARGUMENT"/);
  assert.match(invalidOffset.stdout, /`--offset-block` must be a non-negative integer\./);
});

test("expand requires --key and rejects invalid numeric values", () => {
  const missing = runCli(["expand", "--block-start", "1"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /"code": "MISSING_ARGUMENT"/);
  assert.match(missing.stdout, /Provide --key <key> and --block-start <n> for expand\./);

  const invalidRange = runCli(["expand", "--key", "ITEM1000", "--block-start", "2", "--block-end", "1"]);

  assert.equal(invalidRange.status, 1);
  assert.match(invalidRange.stdout, /"code": "INVALID_ARGUMENT"/);
  assert.match(invalidRange.stdout, /`--block-end` must be greater than or equal to `--block-start`\./);
});

test("fulltext requires --key", () => {
  const missing = runCli(["fulltext"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /"code": "MISSING_ARGUMENT"/);
  assert.match(missing.stdout, /Provide --key <key>\./);
});

test("metadata accumulates repeated field filters", () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-cli-metadata-"));
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
        "zotero-item-key": "ITEM1000",
      },
      {
        title: "Other title",
        abstract: "Needle in abstract",
        author: [{ family: "Doe", given: "John" }],
        issued: { "date-parts": [[2023]] },
        type: "book",
        "zotero-item-key": "ITEM2000",
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
    ["ITEM1000", "ITEM2000"],
  );
});

test("metadata omits abstract by default and includes it with --abstract", () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-cli-metadata-abstract-"));
  const attachmentsRoot = join(root, "attachments");
  mkdirSync(attachmentsRoot, { recursive: true });
  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        title: "Party committees in rural China",
        abstract: "A lengthy abstract about dangwei shuji in county governance.",
        author: [{ family: "Smith", given: "Jane" }],
        issued: { "date-parts": [[2024]] },
        type: "article-journal",
        "zotero-item-key": "ITEM1000",
      },
    ]),
    "utf-8",
  );
  const commonArgs = [
    "metadata",
    "dangwei",
    "--field",
    "abstract",
    "--bibliography",
    bibliographyPath,
    "--attachments-root",
    attachmentsRoot,
    "--data-dir",
    join(root, "data"),
  ];

  const defaultRun = runCli(commonArgs);
  assert.equal(defaultRun.status, 0);
  const defaultParsed = JSON.parse(defaultRun.stdout) as {
    data: { results: Array<{ itemKey: string; abstract?: string }> };
  };
  assert.equal(defaultParsed.data.results[0]?.itemKey, "ITEM1000");
  assert.equal("abstract" in defaultParsed.data.results[0]!, false);

  const withAbstract = runCli([...commonArgs, "--abstract"]);
  assert.equal(withAbstract.status, 0);
  const withAbstractParsed = JSON.parse(withAbstract.stdout) as {
    data: { results: Array<{ itemKey: string; abstract?: string }> };
  };
  assert.equal(
    withAbstractParsed.data.results[0]?.abstract,
    "A lengthy abstract about dangwei shuji in county governance.",
  );
});

test("search keyword returns elapsedMs in meta", async () => {
  const fixture = await createIndexedFixture();

  const result = runCli([
    "search",
    "dangwei shuji",
    "--bibliography",
    fixture.bibliographyPath,
    "--attachments-root",
    fixture.attachmentsRoot,
    "--data-dir",
    fixture.dataDir,
  ]);

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    data: {
      results: Array<{ itemKey: string }>;
    };
    meta?: { elapsedMs?: number };
  };
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data.results.map((row) => row.itemKey), ["ITEM9000"]);
  assert.equal(typeof parsed.meta?.elapsedMs, "number");
});

test("search rejects non-canonical NEAR syntax with an argument error", async () => {
  const fixture = await createIndexedFixture();

  const result = runCli([
    "search",
    'NEAR("party" "secretary", 10)',
    "--bibliography",
    fixture.bibliographyPath,
    "--attachments-root",
    fixture.attachmentsRoot,
    "--data-dir",
    fixture.dataDir,
  ]);

  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    error: { code: string; message: string };
  };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "INVALID_ARGUMENT");
  assert.match(parsed.error.message, /NEAR\(\.\.\.\) is not supported/u);
  assert.match(parsed.error.message, /NEAR\/50/u);
});

test("keyword index searches with FTS5 porter stemming", async () => {
  const fixture = await createIndexedFixture();
  const config = createConfig(fixture.bibliographyPath, fixture.attachmentsRoot, fixture.dataDir);
  const keywordIndex = await openKeywordIndex(config);

  try {
    const results = await keywordIndex.search("dangwei shuji", 10);
    assert.deepEqual(results.map((row) => row.docKey), [fixture.docKey]);

    // Porter stemming: "governance" matches "governs"/"governing" etc.
    const stemmed = await keywordIndex.search("governance", 10);
    assert.equal(stemmed.length, 1);

    const missing = await keywordIndex.search("nonexistent gibberish xyz", 10);
    assert.deepEqual(missing, []);
  } finally {
    await keywordIndex.close();
  }
});

test("search-in returns passages within a selected document", async () => {
  const fixture = await createIndexedFixture();

  const result = runCli([
    "search-in",
    "dangwei shuji",
    "--key",
    "ITEM9000",
    "--bibliography",
    fixture.bibliographyPath,
    "--attachments-root",
    fixture.attachmentsRoot,
    "--data-dir",
    fixture.dataDir,
  ]);

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    data: {
      results: Array<{
        itemKey: string;
        passage: string;
        blockStart: number;
        blockEnd: number;
      }>;
    };
    meta?: { elapsedMs?: number };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.results.length > 0, true);
  assert.equal(parsed.data.results[0]!.itemKey, "ITEM9000");
  assert.equal("file" in parsed.data.results[0]!, false);
  assert.match(parsed.data.results[0]!.passage, /dangwei shuji/i);
  assert.equal(parsed.data.results[0]!.blockStart, 0);
  assert.equal(parsed.data.results[0]!.blockEnd, 0);
  assert.equal(typeof parsed.meta?.elapsedMs, "number");
});

test("search-in searches across all attachments when one key maps to multiple PDFs", async () => {
  const fixture = await createMultiIndexedFixture();

  const result = runCli([
    "search-in",
    "unique paragraph",
    "--key",
    "ITEMM000",
    "--bibliography",
    fixture.bibliographyPath,
    "--attachments-root",
    fixture.attachmentsRoot,
    "--data-dir",
    fixture.dataDir,
    "--limit",
    "10",
  ]);

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    data: {
      results: Array<{ passage: string; blockStart: number; blockEnd: number }>;
    };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.results.length, 2);
  for (const row of parsed.data.results) {
    assert.equal("file" in row, false);
  }
  assert.match(parsed.data.results[0]!.passage, /Unique paragraph 1\./);
  assert.match(parsed.data.results[1]!.passage, /Unique paragraph 2\./);
  assert.ok(
    parsed.data.results[1]!.blockStart > parsed.data.results[0]!.blockStart,
    "second attachment's block index should be offset past the separator",
  );
});

test("expand resolves a unique attachment by itemKey", async () => {
  const fixture = await createIndexedFixture();

  const result = runCli([
    "expand",
    "--key",
    "ITEM9000",
    "--block-start",
    "1",
    "--radius",
    "1",
    "--bibliography",
    fixture.bibliographyPath,
    "--attachments-root",
    fixture.attachmentsRoot,
    "--data-dir",
    fixture.dataDir,
  ]);

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    data: {
      itemKey: string;
      files: string[];
      contextStart: number;
      contextEnd: number;
      passage: string;
    };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.itemKey, "ITEM9000");
  assert.deepEqual(parsed.data.files, [fixture.filePath]);
  assert.equal(parsed.data.contextStart, 0);
  assert.equal(parsed.data.contextEnd, 2);
  assert.match(parsed.data.passage, /Party organization shapes firm governance\./);
});

test("blocks emits citationKey in the output when the manifest has one", async () => {
  const fixture = await createIndexedFixture();

  const result = runCli([
    "blocks",
    "--key",
    "ITEM9000",
    "--limit-blocks",
    "1",
    "--bibliography",
    fixture.bibliographyPath,
    "--attachments-root",
    fixture.attachmentsRoot,
    "--data-dir",
    fixture.dataDir,
  ]);

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    data: {
      itemKey: string;
      citationKey?: string;
      files: string[];
      blocks: Array<{ text: string }>;
    };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.itemKey, "ITEM9000");
  assert.equal(parsed.data.citationKey, fixture.citationKey);
  assert.deepEqual(parsed.data.files, [fixture.filePath]);
  assert.equal(parsed.data.blocks.length, 1);
  assert.match(parsed.data.blocks[0]!.text, /company party secretary/);
});

test("fulltext returns agent-friendly markdown", async () => {
  const fixture = await createIndexedFixture();

  const result = runCli([
    "fulltext",
    "--key",
    "ITEM9000",
    "--bibliography",
    fixture.bibliographyPath,
    "--attachments-root",
    fixture.attachmentsRoot,
    "--data-dir",
    fixture.dataDir,
  ]);

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    data: {
      itemKey: string;
      files: string[];
      format: string;
      source: string;
      keptBlocks: number;
      skippedBoilerplateBlocks: number;
      skippedDuplicateBlocks: number;
      content: string;
    };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.itemKey, "ITEM9000");
  assert.deepEqual(parsed.data.files, [fixture.filePath]);
  assert.equal(parsed.data.format, "markdown");
  assert.equal(parsed.data.source, "normalized");
  assert.equal(parsed.data.keptBlocks, 5);
  assert.equal(parsed.data.skippedBoilerplateBlocks, 0);
  assert.equal(parsed.data.skippedDuplicateBlocks, 0);
  assert.match(parsed.data.content, /dangwei shuji/);
  assert.equal(parsed.data.content.match(/Party organization shapes firm governance\./g)?.length, 2);
  assert.match(parsed.data.content, /To cite this article/i);
  assert.match(parsed.data.content, /Smith, J\./);
});

test("fulltext clean strips common boilerplate", async () => {
  const fixture = await createIndexedFixture();

  const result = runCli([
    "fulltext",
    "--key",
    "ITEM9000",
    "--clean",
    "--bibliography",
    fixture.bibliographyPath,
    "--attachments-root",
    fixture.attachmentsRoot,
    "--data-dir",
    fixture.dataDir,
  ]);

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    data: {
      keptBlocks: number;
      skippedBoilerplateBlocks: number;
      skippedDuplicateBlocks: number;
      content: string;
    };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.keptBlocks, 3);
  assert.equal(parsed.data.skippedBoilerplateBlocks, 1);
  assert.equal(parsed.data.skippedDuplicateBlocks, 1);
  assert.doesNotMatch(parsed.data.content, /To cite this article/i);
  assert.match(parsed.data.content, /Smith, J\./);
});

test("fulltext merges multiple attachments for one itemKey into one document", async () => {
  const fixture = await createMultiIndexedFixture();

  const result = runCli([
    "fulltext",
    "--key",
    "ITEMM000",
    "--bibliography",
    fixture.bibliographyPath,
    "--attachments-root",
    fixture.attachmentsRoot,
    "--data-dir",
    fixture.dataDir,
  ]);

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    data: { itemKey: string; citationKey?: string; files: string[]; content: string };
  };

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data.files, fixture.filePaths);
  assert.equal(parsed.data.citationKey, fixture.citationKey);
  assert.match(parsed.data.content, /Unique paragraph 1\./);
  assert.match(parsed.data.content, /Unique paragraph 2\./);
  assert.match(parsed.data.content, /# Attachment: /);
});

test("fulltext resolves by citationKey when --key is not in itemKey shape", async () => {
  const fixture = await createIndexedFixture();

  const result = runCli([
    "fulltext",
    "--key",
    fixture.citationKey,
    "--bibliography",
    fixture.bibliographyPath,
    "--attachments-root",
    fixture.attachmentsRoot,
    "--data-dir",
    fixture.dataDir,
  ]);

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    data: { itemKey: string; citationKey?: string };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.itemKey, "ITEM9000");
  assert.equal(parsed.data.citationKey, fixture.citationKey);
});

test("blocks reports misses with shape-specific error messages", async () => {
  const fixture = await createIndexedFixture();

  const itemKeyMiss = runCli([
    "blocks",
    "--key",
    "ZZZZZZZZ",
    "--bibliography",
    fixture.bibliographyPath,
    "--attachments-root",
    fixture.attachmentsRoot,
    "--data-dir",
    fixture.dataDir,
  ]);
  assert.equal(itemKeyMiss.status, 1);
  assert.match(itemKeyMiss.stdout, /"code": "BLOCKS_FAILED"/);
  assert.match(itemKeyMiss.stdout, /No indexed attachment found for itemKey: ZZZZZZZZ/);

  const citationKeyMiss = runCli([
    "blocks",
    "--key",
    "unknown-cite-2099",
    "--bibliography",
    fixture.bibliographyPath,
    "--attachments-root",
    fixture.attachmentsRoot,
    "--data-dir",
    fixture.dataDir,
  ]);
  assert.equal(citationKeyMiss.status, 1);
  assert.match(citationKeyMiss.stdout, /"code": "BLOCKS_FAILED"/);
  assert.match(citationKeyMiss.stdout, /No indexed attachment found for citationKey: unknown-cite-2099/);
});

test("fulltext strips a leading @ from --key so Pandoc-style citations resolve", async () => {
  const fixture = await createIndexedFixture();

  const result = runCli([
    "fulltext",
    "--key",
    `@${fixture.citationKey}`,
    "--bibliography",
    fixture.bibliographyPath,
    "--attachments-root",
    fixture.attachmentsRoot,
    "--data-dir",
    fixture.dataDir,
  ]);

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    data: { itemKey: string; citationKey?: string };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.itemKey, "ITEM9000");
  assert.equal(parsed.data.citationKey, fixture.citationKey);
});

test("unknown flags are rejected with UNEXPECTED_ARGUMENT rather than silently ignored", () => {
  const oldRenameFlag = runCli(["metadata", "dangwei", "--has-pdf"]);
  assert.equal(oldRenameFlag.status, 1);
  assert.match(oldRenameFlag.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(oldRenameFlag.stdout, /Remove: --has-pdf/);

  const typo = runCli(["blocks", "--key", "ABCD1234", "--limit-block", "5"]);
  assert.equal(typo.status, 1);
  assert.match(typo.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(typo.stdout, /Remove: --limit-block/);

  const mixedWithGlobalOverride = runCli([
    "fulltext",
    "--key",
    "ABCD1234",
    "--data-dir",
    "/tmp/whatever",
    "--no-such-thing",
  ]);
  assert.equal(mixedWithGlobalOverride.status, 1);
  assert.match(mixedWithGlobalOverride.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(mixedWithGlobalOverride.stdout, /Remove: --no-such-thing/);
});
