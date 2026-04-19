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
    itemKey: "ITEM9",
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
    entries: [readyEntry(dataDir, docKey, "ITEM9", citationKey, "Exact match", filePath, manifestPath)],
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
      itemKey: "ITEMM",
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
        "ITEMM",
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
    /search-in "<text>" \(--item-key <key> \| --citation-key <key>\) \[--limit <n>\]/,
  );
  assert.match(result.stdout, /metadata "<text>" \[--limit <n>\] \[--field <field>\] \[--has-file\]/);
  assert.match(result.stdout, /^Read$/m);
  assert.match(
    result.stdout,
    /read \(--item-key <key> \| --citation-key <key>\) \[--offset-block <n>\] \[--limit-blocks <n>\]/,
  );
  assert.match(
    result.stdout,
    /fulltext \(--item-key <key> \| --citation-key <key>\) \[--clean\]/,
  );
  assert.match(
    result.stdout,
    /expand \(--item-key <key> \| --citation-key <key>\) --block-start <n> \[--block-end <n>\] \[--radius <n>\]/,
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
  assert.match(result.stdout, /--field <field>\s+Limit metadata search/);
  assert.match(result.stdout, /--has-file\s+Keep only metadata results/);
  assert.match(result.stdout, /--abstract\s+Include the abstract in each result/);
  assert.match(result.stdout, /--clean\s+Apply heuristic cleanup/);

  // Document selectors are described once in their own block.
  assert.match(result.stdout, /^Document selectors \(used by search-in, read, fulltext, expand\)$/m);
  assert.match(result.stdout, /--item-key <key>\s+Resolve an indexed item by Zotero item key\./);
  assert.match(result.stdout, /--citation-key <key>\s+Resolve an indexed item by citation key\./);

  // Other / config / examples sections are present.
  assert.match(result.stdout, /version, --version\s+Print the current zotagent version\./);
  assert.match(result.stdout, /help, --help\s+Show this help\./);
  assert.match(result.stdout, /Paths and credentials are read from \~\/\.zotagent\/config\.json\./);
  assert.match(result.stdout, /zoteroLibraryType supports both user and group\./);
  assert.match(result.stdout, /zoteroCollectionKey sets the default collection/);
  assert.match(result.stdout, /^Examples$/m);

  // Config-only overrides should not appear in user-facing help.
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

test("search rejects removed query flag and points to positional usage", () => {
  const result = runCli(["search", "--query", "aging in China"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(result.stdout, /`--query` has been removed/);
  assert.match(result.stdout, /zotagent search .*<text>.*/);
});

test("search rejects combining keyword mode with semantic", () => {
  const result = runCli(["search", "--keyword", "--semantic", "dangwei shuji"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(result.stdout, /`--keyword` cannot be combined with `--semantic`/);
});

test("metadata rejects removed query flag and points to positional usage", () => {
  const result = runCli(["metadata", "--query", "aging in China"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(result.stdout, /`--query` is not supported/);
  assert.match(result.stdout, /zotagent metadata .*<text>.*/);
});

test("metadata rejects search-only flags", () => {
  const result = runCli(["metadata", "--keyword", "aging in China"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(result.stdout, /metadata only supports --limit, --field, --has-file, and --abstract/);
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

test("search-in rejects conflicting selectors and invalid limit values", () => {
  const conflict = runCli([
    "search-in",
    "party",
    "--item-key",
    "ITEM1",
    "--citation-key",
    "cite1",
  ]);

  assert.equal(conflict.status, 1);
  assert.match(conflict.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(conflict.stdout, /Provide exactly one of --item-key <key> or --citation-key <key>\./);

  const legacyFile = runCli(["search-in", "party", "--file", "/tmp/paper.pdf"]);
  assert.equal(legacyFile.status, 1);
  assert.match(legacyFile.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(legacyFile.stdout, /`--file` has been removed/);

  const invalidLimit = runCli(["search-in", "party", "--item-key", "ITEM1", "--limit", "0"]);

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

test("read rejects conflicting selectors and invalid numeric values", () => {
  const conflict = runCli(["read", "--item-key", "ITEM1", "--citation-key", "cite1"]);

  assert.equal(conflict.status, 1);
  assert.match(conflict.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(conflict.stdout, /Provide exactly one of --item-key <key> or --citation-key <key>\./);

  const legacyFile = runCli(["read", "--file", "/tmp/paper.pdf"]);
  assert.equal(legacyFile.status, 1);
  assert.match(legacyFile.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(legacyFile.stdout, /`--file` has been removed/);

  const invalidOffset = runCli(["read", "--item-key", "ITEM1", "--offset-block", "-1"]);

  assert.equal(invalidOffset.status, 1);
  assert.match(invalidOffset.stdout, /"code": "INVALID_ARGUMENT"/);
  assert.match(invalidOffset.stdout, /`--offset-block` must be a non-negative integer\./);
});

test("expand rejects conflicting selectors and invalid numeric values", () => {
  const conflict = runCli([
    "expand",
    "--item-key",
    "ITEM1",
    "--citation-key",
    "cite1",
    "--block-start",
    "1",
  ]);

  assert.equal(conflict.status, 1);
  assert.match(conflict.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(conflict.stdout, /Provide exactly one of --item-key <key> or --citation-key <key>\./);

  const legacyFile = runCli(["expand", "--file", "/tmp/paper.pdf", "--block-start", "1"]);
  assert.equal(legacyFile.status, 1);
  assert.match(legacyFile.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(legacyFile.stdout, /`--file` has been removed/);

  const invalidRange = runCli(["expand", "--item-key", "ITEM1", "--block-start", "2", "--block-end", "1"]);

  assert.equal(invalidRange.status, 1);
  assert.match(invalidRange.stdout, /"code": "INVALID_ARGUMENT"/);
  assert.match(invalidRange.stdout, /`--block-end` must be greater than or equal to `--block-start`\./);
});

test("fulltext rejects conflicting selectors", () => {
  const conflict = runCli(["fulltext", "--item-key", "ITEM1", "--citation-key", "cite1"]);

  assert.equal(conflict.status, 1);
  assert.match(conflict.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(conflict.stdout, /Provide exactly one of --item-key <key> or --citation-key <key>\./);

  const legacyFile = runCli(["fulltext", "--file", "/tmp/paper.pdf"]);
  assert.equal(legacyFile.status, 1);
  assert.match(legacyFile.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(legacyFile.stdout, /`--file` has been removed/);
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
        "zotero-item-key": "ITEM1",
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
  assert.equal(defaultParsed.data.results[0]?.itemKey, "ITEM1");
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
  assert.deepEqual(parsed.data.results.map((row) => row.itemKey), ["ITEM9"]);
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
    "--item-key",
    "ITEM9",
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
  assert.equal(parsed.data.results[0]!.itemKey, "ITEM9");
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
    "--item-key",
    "ITEMM",
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
    "--item-key",
    "ITEM9",
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
  assert.equal(parsed.data.itemKey, "ITEM9");
  assert.deepEqual(parsed.data.files, [fixture.filePath]);
  assert.equal(parsed.data.contextStart, 0);
  assert.equal(parsed.data.contextEnd, 2);
  assert.match(parsed.data.passage, /Party organization shapes firm governance\./);
});

test("read resolves a unique attachment by citationKey", async () => {
  const fixture = await createIndexedFixture();

  const result = runCli([
    "read",
    "--citation-key",
    fixture.citationKey,
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
  assert.equal(parsed.data.itemKey, "ITEM9");
  assert.equal(parsed.data.citationKey, fixture.citationKey);
  assert.deepEqual(parsed.data.files, [fixture.filePath]);
  assert.equal(parsed.data.blocks.length, 1);
  assert.match(parsed.data.blocks[0]!.text, /company party secretary/);
});

test("fulltext returns agent-friendly markdown", async () => {
  const fixture = await createIndexedFixture();

  const result = runCli([
    "fulltext",
    "--item-key",
    "ITEM9",
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
  assert.equal(parsed.data.itemKey, "ITEM9");
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
    "--item-key",
    "ITEM9",
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

test("fulltext merges multiple attachments under one itemKey or citationKey into one document", async () => {
  const fixture = await createMultiIndexedFixture();

  const byItemKey = runCli([
    "fulltext",
    "--item-key",
    "ITEMM",
    "--bibliography",
    fixture.bibliographyPath,
    "--attachments-root",
    fixture.attachmentsRoot,
    "--data-dir",
    fixture.dataDir,
  ]);
  const byCitationKey = runCli([
    "fulltext",
    "--citation-key",
    fixture.citationKey,
    "--bibliography",
    fixture.bibliographyPath,
    "--attachments-root",
    fixture.attachmentsRoot,
    "--data-dir",
    fixture.dataDir,
  ]);

  assert.equal(byItemKey.status, 0);
  assert.equal(byCitationKey.status, 0);

  const parsedItem = JSON.parse(byItemKey.stdout) as {
    ok: boolean;
    data: { itemKey: string; files: string[]; content: string };
  };
  const parsedCitation = JSON.parse(byCitationKey.stdout) as {
    ok: boolean;
    data: { itemKey: string; files: string[]; content: string };
  };

  assert.equal(parsedItem.ok, true);
  assert.equal(parsedCitation.ok, true);
  assert.deepEqual(parsedItem.data.files, fixture.filePaths);
  assert.deepEqual(parsedCitation.data.files, fixture.filePaths);
  assert.match(parsedItem.data.content, /Unique paragraph 1\./);
  assert.match(parsedItem.data.content, /Unique paragraph 2\./);
  assert.match(parsedItem.data.content, /# Attachment: /);
});

test("expand resolves a unique attachment by citationKey", async () => {
  const fixture = await createIndexedFixture();

  const result = runCli([
    "expand",
    "--citation-key",
    fixture.citationKey,
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
      citationKey?: string;
      files: string[];
      contextStart: number;
      contextEnd: number;
    };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.itemKey, "ITEM9");
  assert.equal(parsed.data.citationKey, fixture.citationKey);
  assert.deepEqual(parsed.data.files, [fixture.filePath]);
  assert.equal(parsed.data.contextStart, 0);
  assert.equal(parsed.data.contextEnd, 2);
});
