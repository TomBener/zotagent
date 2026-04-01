import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildHiddenJavaToolOptions, runSync, withHiddenJavaDockIcon } from "./sync.js";
import { writeCatalogFile } from "./state.js";
import type { CatalogFile } from "./types.js";
import { sha1 } from "./utils.js";

test("buildHiddenJavaToolOptions appends dock-hiding flag without dropping existing options", () => {
  assert.equal(
    buildHiddenJavaToolOptions("-Xmx2g"),
    "-Xmx2g -Dapple.awt.UIElement=true",
  );
  assert.equal(
    buildHiddenJavaToolOptions("-Xmx2g -Dapple.awt.UIElement=true"),
    "-Xmx2g -Dapple.awt.UIElement=true",
  );
  assert.equal(buildHiddenJavaToolOptions(undefined), "-Dapple.awt.UIElement=true");
});

test("withHiddenJavaDockIcon only applies on macOS and restores environment afterwards", async () => {
  const env: NodeJS.ProcessEnv = {};
  let seenDuringTask = "";

  const result = await withHiddenJavaDockIcon(
    async () => {
      seenDuringTask = env.JAVA_TOOL_OPTIONS || "";
      return "ok";
    },
    { platform: "darwin", env },
  );

  assert.equal(result, "ok");
  assert.equal(seenDuringTask, "-Dapple.awt.UIElement=true");
  assert.equal(env.JAVA_TOOL_OPTIONS, undefined);

  env.JAVA_TOOL_OPTIONS = "-Xmx1g";
  await withHiddenJavaDockIcon(
    async () => {
      seenDuringTask = env.JAVA_TOOL_OPTIONS || "";
    },
    { platform: "linux", env },
  );
  assert.equal(seenDuringTask, "-Xmx1g");
  assert.equal(env.JAVA_TOOL_OPTIONS, "-Xmx1g");

  env.ZOTLIT_SHOW_JAVA_DOCK_ICON = "1";
  await withHiddenJavaDockIcon(
    async () => {
      seenDuringTask = env.JAVA_TOOL_OPTIONS || "";
    },
    { platform: "darwin", env },
  );
  assert.equal(seenDuringTask, "-Xmx1g");
  assert.equal(env.JAVA_TOOL_OPTIONS, "-Xmx1g");
});

test("runSync skips unchanged ready pdfs and refreshes qmd contexts", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-sync-"));
  const attachmentsRoot = join(root, "attachments");
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  const normalizedDir = join(dataDir, "normalized");
  mkdirSync(join(attachmentsRoot, "papers"), { recursive: true });
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });
  mkdirSync(normalizedDir, { recursive: true });

  const pdfPath = join(attachmentsRoot, "papers", "paper.pdf");
  writeFileSync(pdfPath, "pdf");
  const currentStat = statSync(pdfPath);
  const docKey = sha1(pdfPath);
  const normalizedPath = join(normalizedDir, `${docKey}.md`);
  const manifestPath = join(manifestsDir, `${docKey}.json`);
  writeFileSync(normalizedPath, "Body");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      docKey,
      itemKey: "ITEM1",
      title: "Paper",
      authors: ["A"],
      filePath: pdfPath,
      normalizedPath,
      blocks: [],
    }),
    "utf-8",
  );

  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "cite",
        title: "Paper",
        author: [{ family: "A", given: "Author" }],
        file: pdfPath,
        "zotero-item-key": "ITEM1",
      },
    ]),
    "utf-8",
  );

  const previousCatalog: CatalogFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [
      {
        docKey,
        itemKey: "ITEM1",
        citationKey: "cite",
        title: "Paper",
        authors: ["A Author"],
        filePath: pdfPath,
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: currentStat.size,
        mtimeMs: Math.trunc(currentStat.mtimeMs),
        sourceHash: "existinghash",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath,
        manifestPath,
      },
    ],
  };
  writeCatalogFile(join(indexDir, "catalog.json"), previousCatalog);

  const calls = {
    update: 0,
    embed: 0,
    removed: 0,
    added: 0,
    closed: 0,
  };

  const fakeFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => {
      calls.update += 1;
      return {};
    },
    embed: async () => {
      calls.embed += 1;
      return {};
    },
    getStatus: async () => ({ documents: 1, collections: [], embeddings: { total: 1, stale: 0 } }),
    listContexts: async () => [{ collection: "library", path: "/old.md", context: "old" }],
    addContext: async () => {
      calls.added += 1;
      return true;
    },
    removeContext: async () => {
      calls.removed += 1;
      return true;
    },
    close: async () => {
      calls.closed += 1;
    },
  });

  const result = await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
  );

  assert.equal(result.stats.skippedAttachments, 1);
  assert.equal(result.stats.updatedAttachments, 0);
  assert.equal(calls.update, 1);
  assert.equal(calls.embed, 1);
  assert.equal(calls.removed, 1);
  assert.equal(calls.added, 1);
  assert.equal(calls.closed, 1);
});

test("runSync removes stale normalized and manifest files when attachment disappears", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-stale-"));
  const attachmentsRoot = join(root, "attachments");
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  const normalizedDir = join(dataDir, "normalized");
  mkdirSync(attachmentsRoot, { recursive: true });
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });
  mkdirSync(normalizedDir, { recursive: true });

  const docKey = "6".repeat(40);
  const normalizedPath = join(normalizedDir, `${docKey}.md`);
  const manifestPath = join(manifestsDir, `${docKey}.json`);
  writeFileSync(normalizedPath, "Body");
  writeFileSync(manifestPath, "{}");
  writeFileSync(join(root, "bibliography.json"), "[]");

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [
      {
        docKey,
        itemKey: "ITEM1",
        title: "Stale",
        authors: [],
        filePath: join(attachmentsRoot, "missing.pdf"),
        fileExt: "pdf",
        exists: false,
        supported: true,
        extractStatus: "ready",
        size: 1,
        mtimeMs: 1,
        sourceHash: "hash",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath,
        manifestPath,
      },
    ],
  });

  const fakeFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ documents: 0, collections: [], embeddings: { total: 0, stale: 0 } }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    close: async () => {},
  });

  const result = await runSync(
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
  );

  assert.equal(result.stats.removedAttachments, 1);
  assert.equal(statSync(indexDir).isDirectory(), true);
  assert.equal(existsSync(normalizedPath), false);
  assert.equal(existsSync(manifestPath), false);
});
