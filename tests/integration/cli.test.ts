import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { openExactIndex } from "../../src/tantivy.js";
import { writeCatalogFile } from "../../src/state.js";
import type { AppConfig, AttachmentManifest, CatalogEntry, CatalogFile } from "../../src/types.js";

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
  writeFileSync(path, JSON.stringify(manifest, null, 2), "utf-8");
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
  filePath: string;
  citationKey: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "zotlit-cli-indexed-"));
  const attachmentsRoot = join(root, "attachments");
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  const bibliographyPath = join(root, "bibliography.json");
  const docKey = "9".repeat(40);
  const filePath = join(attachmentsRoot, "paper.pdf");
  const manifestPath = join(manifestsDir, `${docKey}.json`);
  const citationKey = "lee2024party";

  mkdirSync(attachmentsRoot, { recursive: true });
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });
  writeFileSync(bibliographyPath, "[]", "utf-8");

  writeManifest(manifestPath, {
    docKey,
    itemKey: "ITEM9",
    citationKey,
    title: "Exact match",
    authors: ["A"],
    filePath,
    normalizedPath: join(dataDir, "normalized", `${docKey}.md`),
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

  const exactIndex = await openExactIndex(createConfig(bibliographyPath, attachmentsRoot, dataDir));
  try {
    await exactIndex.rebuildExactIndex(catalog.entries);
  } finally {
    await exactIndex.close();
  }

  return { root, bibliographyPath, attachmentsRoot, dataDir, filePath, citationKey };
}

async function createMultiIndexedFixture(): Promise<{
  bibliographyPath: string;
  attachmentsRoot: string;
  dataDir: string;
  citationKey: string;
  filePaths: string[];
}> {
  const root = mkdtempSync(join(tmpdir(), "zotlit-cli-multi-"));
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
    const manifestPath = join(manifestsDir, `${docKey}.json`);
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
        join(manifestsDir, `${docKey}.json`),
      ),
    ),
  });

  return { bibliographyPath, attachmentsRoot, dataDir, citationKey, filePaths };
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
  assert.match(result.stdout, /zotlit fulltext \(\[?--file <path> \| --item-key <key> \| --citation-key <key>\)?/);
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
  assert.match(result.stdout, /zotlit expand \(\[?--file <path> \| --item-key <key> \| --citation-key <key>\)?/);
  assert.match(result.stdout, /Use one of --file, --item-key, or --citation-key\./);
  assert.match(result.stdout, /fulltext\s+Output agent-friendly full text from a local manifest\./);
  assert.match(result.stdout, /--item-key <key>\s+Resolve an indexed attachment by Zotero item key/);
  assert.match(result.stdout, /--citation-key <key>\s+Resolve an indexed attachment by citation key/);
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

test("metadata rejects invalid limit values", () => {
  const result = runCli(["metadata", "aging in China", "--limit"]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"code": "INVALID_ARGUMENT"/);
  assert.match(result.stdout, /`--limit` requires a positive integer\./);
});

test("read rejects conflicting selectors and invalid numeric values", () => {
  const conflict = runCli(["read", "--file", "/tmp/paper.pdf", "--item-key", "ITEM1"]);

  assert.equal(conflict.status, 1);
  assert.match(conflict.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(conflict.stdout, /Provide exactly one of --file <path>, --item-key <key>, or --citation-key <key>\./);

  const invalidOffset = runCli(["read", "--item-key", "ITEM1", "--offset-block", "-1"]);

  assert.equal(invalidOffset.status, 1);
  assert.match(invalidOffset.stdout, /"code": "INVALID_ARGUMENT"/);
  assert.match(invalidOffset.stdout, /`--offset-block` must be a non-negative integer\./);
});

test("expand rejects conflicting selectors and invalid numeric values", () => {
  const conflict = runCli([
    "expand",
    "--file",
    "/tmp/paper.pdf",
    "--item-key",
    "ITEM1",
    "--block-start",
    "1",
  ]);

  assert.equal(conflict.status, 1);
  assert.match(conflict.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(conflict.stdout, /Provide exactly one of --file <path>, --item-key <key>, or --citation-key <key>\./);

  const invalidRange = runCli(["expand", "--item-key", "ITEM1", "--block-start", "2", "--block-end", "1"]);

  assert.equal(invalidRange.status, 1);
  assert.match(invalidRange.stdout, /"code": "INVALID_ARGUMENT"/);
  assert.match(invalidRange.stdout, /`--block-end` must be greater than or equal to `--block-start`\./);
});

test("fulltext rejects conflicting selectors", () => {
  const conflict = runCli(["fulltext", "--file", "/tmp/paper.pdf", "--item-key", "ITEM1"]);

  assert.equal(conflict.status, 1);
  assert.match(conflict.stdout, /"code": "UNEXPECTED_ARGUMENT"/);
  assert.match(conflict.stdout, /Provide exactly one of --file <path>, --item-key <key>, or --citation-key <key>\./);
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

test("search exact returns elapsedMs in meta", async () => {
  const fixture = await createIndexedFixture();

  const result = runCli([
    "search",
    "dangwei shuji",
    "--exact",
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
      file: string;
      contextStart: number;
      contextEnd: number;
      passage: string;
    };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.itemKey, "ITEM9");
  assert.equal(parsed.data.file, fixture.filePath);
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
      file: string;
      blocks: Array<{ text: string }>;
    };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.itemKey, "ITEM9");
  assert.equal(parsed.data.citationKey, fixture.citationKey);
  assert.equal(parsed.data.file, fixture.filePath);
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
      results: Array<{
        itemKey: string;
        file: string;
        format: string;
        keptBlocks: number;
        skippedBoilerplateBlocks: number;
        skippedDuplicateBlocks: number;
        skippedReferenceBlocks: number;
        content: string;
      }>;
    };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.results.length, 1);
  assert.equal(parsed.data.results[0]!.itemKey, "ITEM9");
  assert.equal(parsed.data.results[0]!.file, fixture.filePath);
  assert.equal(parsed.data.results[0]!.format, "markdown");
  assert.equal(parsed.data.results[0]!.keptBlocks, 2);
  assert.equal(parsed.data.results[0]!.skippedBoilerplateBlocks, 1);
  assert.equal(parsed.data.results[0]!.skippedDuplicateBlocks, 1);
  assert.equal(parsed.data.results[0]!.skippedReferenceBlocks, 1);
  assert.match(parsed.data.results[0]!.content, /dangwei shuji/);
  assert.equal(parsed.data.results[0]!.content.match(/Party organization shapes firm governance\./g)?.length, 1);
  assert.doesNotMatch(parsed.data.results[0]!.content, /To cite this article/i);
  assert.doesNotMatch(parsed.data.results[0]!.content, /Smith, J\./);
});

test("fulltext returns all matched attachments for duplicate itemKey or citationKey", async () => {
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
    data: { results: Array<{ file: string; content: string }> };
  };
  const parsedCitation = JSON.parse(byCitationKey.stdout) as {
    ok: boolean;
    data: { results: Array<{ file: string; content: string }> };
  };

  assert.equal(parsedItem.ok, true);
  assert.equal(parsedCitation.ok, true);
  assert.deepEqual(
    parsedItem.data.results.map((row) => row.file),
    fixture.filePaths,
  );
  assert.deepEqual(
    parsedCitation.data.results.map((row) => row.file),
    fixture.filePaths,
  );
  assert.match(parsedItem.data.results[0]!.content, /Unique paragraph 1\./);
  assert.match(parsedItem.data.results[1]!.content, /Unique paragraph 2\./);
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
      file: string;
      contextStart: number;
      contextEnd: number;
    };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.itemKey, "ITEM9");
  assert.equal(parsed.data.citationKey, fixture.citationKey);
  assert.equal(parsed.data.file, fixture.filePath);
  assert.equal(parsed.data.contextStart, 0);
  assert.equal(parsed.data.contextEnd, 2);
});
