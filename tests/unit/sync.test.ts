import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  annotateWithFallbackFailures,
  buildContext,
  buildIndexerSignature,
  buildJavaToolOptions,
  runProcessWithTimeout,
  runSync,
  withJavaToolOptions,
} from "../../src/sync.js";
import { readCatalogFile, writeCatalogFile } from "../../src/state.js";
import type { CatalogFile, ManifestBlock } from "../../src/types.js";
import { MANIFEST_EXT, readManifestFile, sha1, writeManifestFile } from "../../src/utils.js";

function trivialBlock(): ManifestBlock {
  return {
    blockIndex: 0,
    blockType: "paragraph",
    sectionPath: [],
    text: "Body",
    charStart: 0,
    charEnd: 4,
    lineStart: 1,
    lineEnd: 1,
    isReferenceLike: false,
  };
}

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const syncModuleUrl = new URL("../../src/sync.ts", import.meta.url).href;

function runInlineModule(script: string, timeout = 5_000) {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout,
  });
}

test("buildJavaToolOptions always adds -Xss and optionally dock-hide flag", () => {
  assert.equal(
    buildJavaToolOptions("-Xmx2g", { hideDockIcon: true }),
    "-Xmx2g -Xss32m -Dapple.awt.UIElement=true",
  );
  assert.equal(
    buildJavaToolOptions("-Xmx2g -Xss32m -Dapple.awt.UIElement=true", { hideDockIcon: true }),
    "-Xmx2g -Xss32m -Dapple.awt.UIElement=true",
  );
  assert.equal(
    buildJavaToolOptions(undefined, { hideDockIcon: true }),
    "-Xss32m -Dapple.awt.UIElement=true",
  );
  assert.equal(
    buildJavaToolOptions("-Xmx2g", { hideDockIcon: false }),
    "-Xmx2g -Xss32m",
  );
  assert.equal(buildJavaToolOptions(undefined, { hideDockIcon: false }), "-Xss32m");
});

test("withJavaToolOptions injects -Xss everywhere and adds dock-hide only on macOS, restoring env", async () => {
  const env: NodeJS.ProcessEnv = {};
  let seenDuringTask = "";

  const result = await withJavaToolOptions(
    async () => {
      seenDuringTask = env.JAVA_TOOL_OPTIONS || "";
      return "ok";
    },
    { platform: "darwin", env },
  );

  assert.equal(result, "ok");
  assert.equal(seenDuringTask, "-Xss32m -Dapple.awt.UIElement=true");
  assert.equal(env.JAVA_TOOL_OPTIONS, undefined);

  env.JAVA_TOOL_OPTIONS = "-Xmx1g";
  await withJavaToolOptions(
    async () => {
      seenDuringTask = env.JAVA_TOOL_OPTIONS || "";
    },
    { platform: "linux", env },
  );
  assert.equal(seenDuringTask, "-Xmx1g -Xss32m");
  assert.equal(env.JAVA_TOOL_OPTIONS, "-Xmx1g");

  env.ZOTAGENT_SHOW_JAVA_DOCK_ICON = "1";
  await withJavaToolOptions(
    async () => {
      seenDuringTask = env.JAVA_TOOL_OPTIONS || "";
    },
    { platform: "darwin", env },
  );
  assert.equal(seenDuringTask, "-Xmx1g -Xss32m");
  assert.equal(env.JAVA_TOOL_OPTIONS, "-Xmx1g");
});

test("annotateWithFallbackFailures appends tier-specific messages to the primary error", () => {
  const primary = new Error("java.lang.StackOverflowError");
  const result = annotateWithFallbackFailures(primary, [
    { tier: "odl-text", error: new Error("OpenDataLoader timed out after 600000ms.\n  at …") },
    { tier: "pdftotext", error: new Error("spawn pdftotext ENOENT") },
  ]);
  assert.equal(result, primary);
  assert.match(
    primary.message,
    /StackOverflowError \(fallbacks also failed: odl-text: OpenDataLoader timed out after 600000ms\.; pdftotext: spawn pdftotext ENOENT\)/,
  );
});

test("annotateWithFallbackFailures leaves the primary error untouched when nothing failed", () => {
  const primary = new Error("original");
  const result = annotateWithFallbackFailures(primary, []);
  assert.equal(result, primary);
  assert.equal(primary.message, "original");
});

test("runProcessWithTimeout terminates a hung child process", async () => {
  await assert.rejects(
    runProcessWithTimeout({
      command: process.execPath,
      args: ["-e", "process.stderr.write('still running\\n'); setInterval(() => {}, 1000);"],
      timeoutMs: 50,
      label: "test process",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /test process timed out after 50ms/);
      return true;
    },
  );
});

test("runProcessWithTimeout keeps only the tail of oversized child output", async () => {
  await assert.rejects(
    runProcessWithTimeout({
      command: process.execPath,
      args: [
        "-e",
        [
          "process.stderr.write('A'.repeat(300000));",
          "process.stderr.write('tail-marker\\n', () => process.exit(1));",
        ].join(" "),
      ],
      timeoutMs: 5_000,
      label: "noisy process",
      maxBufferedOutputBytes: 4096,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /noisy process exited with code 1/);
      assert.match(error.message, /\[truncated \d+ earlier bytes\]/);
      assert.match(error.message, /tail-marker/);
      assert.doesNotMatch(error.message, /^A{1000}/);
      return true;
    },
  );
});

test("runSync relays SIGINT instead of swallowing it", () => {
  const result = runInlineModule(
    `
      import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { runSync } from ${JSON.stringify(syncModuleUrl)};

      const root = mkdtempSync(join(tmpdir(), "zotagent-sync-signal-"));
      const attachmentsRoot = join(root, "attachments");
      const dataDir = join(root, "data");
      mkdirSync(attachmentsRoot, { recursive: true });

      const pdfPath = join(attachmentsRoot, "paper.pdf");
      const bibliographyPath = join(root, "bibliography.json");
      writeFileSync(pdfPath, "pdf");
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

      const fakeFactory = async () => ({
        search: async () => [],
        searchLex: async () => [],
        update: async () => ({}),
        embed: async () => ({}),
        getStatus: async () => ({ totalDocuments: 0, needsEmbedding: 0, hasVectorIndex: false, collections: [] }),
        listContexts: async () => [],
        addContext: async () => true,
        removeContext: async () => true,
        clearEmbeddings: async () => {},
        cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
        close: async () => {},
      });
      const fakeExtractBatch = async () => {
        setInterval(() => {}, 1000);
        return await new Promise(() => {});
      };

      setTimeout(() => {
        process.kill(process.pid, "SIGINT");
      }, 50);

      await runSync(
        {
          bibliographyJsonPath: bibliographyPath,
          attachmentsRoot,
          dataDir,
        },
        fakeFactory,
        undefined,
        fakeExtractBatch,
        () => {},
      );
    `,
    2_000,
  );

  assert.equal(result.error, undefined);
  assert.equal(result.signal, "SIGINT");
});

test("runSync does not swallow uncaught exceptions", () => {
  const result = runInlineModule(
    `
      import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { runSync } from ${JSON.stringify(syncModuleUrl)};

      const root = mkdtempSync(join(tmpdir(), "zotagent-sync-uncaught-"));
      const attachmentsRoot = join(root, "attachments");
      const dataDir = join(root, "data");
      mkdirSync(attachmentsRoot, { recursive: true });

      const pdfPath = join(attachmentsRoot, "paper.pdf");
      const bibliographyPath = join(root, "bibliography.json");
      writeFileSync(pdfPath, "pdf");
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

      const fakeFactory = async () => ({
        search: async () => [],
        searchLex: async () => [],
        update: async () => ({}),
        embed: async () => ({}),
        getStatus: async () => ({ totalDocuments: 0, needsEmbedding: 0, hasVectorIndex: false, collections: [] }),
        listContexts: async () => [],
        addContext: async () => true,
        removeContext: async () => true,
        clearEmbeddings: async () => {},
        cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
        close: async () => {},
      });
      const fakeExtractBatch = async () => {
        setInterval(() => {}, 1000);
        return await new Promise(() => {});
      };

      setTimeout(() => {
        throw new Error("boom");
      }, 50);

      await runSync(
        {
          bibliographyJsonPath: bibliographyPath,
          attachmentsRoot,
          dataDir,
        },
        fakeFactory,
        undefined,
        fakeExtractBatch,
        () => {},
      );
    `,
    2_000,
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /boom/);
});

test("runSync skips unchanged ready pdfs and refreshes qmd contexts", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-"));
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
  const docKey = sha1("papers/paper.pdf");
  const normalizedPath = join(normalizedDir, `${docKey}.md`);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  writeFileSync(normalizedPath, "Body");
  writeManifestFile(
    manifestPath,
    {
      docKey,
      itemKey: "ITEM1",
      title: "Paper",
      authors: ["A"],
      filePath: pdfPath,
      normalizedPath,
      blocks: [trivialBlock()],
    },
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

  let needsEmbedding = 1;
  const fakeFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => {
      calls.update += 1;
      return {};
    },
    embed: async () => {
      calls.embed += 1;
      needsEmbedding = 0;
      return {};
    },
    getStatus: async () => ({ totalDocuments: 1, needsEmbedding, hasVectorIndex: needsEmbedding === 0, collections: [] }),
    listContexts: async () => [{ collection: "library", path: "/old.md", context: "old" }],
    addContext: async () => {
      calls.added += 1;
      return true;
    },
    removeContext: async () => {
      calls.removed += 1;
      return true;
    },
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
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

  const logBody = readFileSync(result.logPath, "utf-8");
  assert.match(logBody, /## Skipped Files/);
  assert.match(logBody, /paper\.pdf: reused existing indexed output/);
});

test("runSync short-circuits both index rebuilds when the catalog is identical to a completed sync", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-shortcircuit-"));
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
  const pdfStat = statSync(pdfPath);
  const docKey = sha1("papers/paper.pdf");
  const normalizedPath = join(normalizedDir, `${docKey}.md`);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  writeFileSync(normalizedPath, "Body");
  writeManifestFile(manifestPath, {
    docKey,
    itemKey: "ITEM1",
    title: "Paper",
    authors: ["Author One"],
    filePath: pdfPath,
    normalizedPath,
    blocks: [trivialBlock()],
  });

  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "cite",
        title: "Paper",
        author: [{ family: "One", given: "Author" }],
        file: pdfPath,
        "zotero-item-key": "ITEM1",
      },
    ]),
    "utf-8",
  );

  const previousEntry = {
    docKey,
    itemKey: "ITEM1",
    citationKey: "cite",
    title: "Paper",
    authors: ["One Author"],
    filePath: pdfPath,
    fileExt: "pdf" as const,
    exists: true,
    supported: true,
    extractStatus: "ready" as const,
    size: pdfStat.size,
    mtimeMs: Math.trunc(pdfStat.mtimeMs),
    sourceHash: "existinghash",
    lastIndexedAt: new Date().toISOString(),
    normalizedPath,
    manifestPath,
  };
  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    indexesCompletedAt: new Date().toISOString(),
    indexedQmdEmbedModel: "fake-embed-model",
    indexerSignature: buildIndexerSignature("fake-embed-model"),
    entries: [previousEntry],
  });

  const qmdCalls = { opened: 0, update: 0, listContexts: 0 };
  const qmdFactory = async () => {
    qmdCalls.opened += 1;
    return {
      search: async () => [],
      searchLex: async () => [],
      update: async () => {
        qmdCalls.update += 1;
        return {};
      },
      embed: async () => ({}),
      getStatus: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
      listContexts: async () => {
        qmdCalls.listContexts += 1;
        return [];
      },
      addContext: async () => true,
      removeContext: async () => true,
      clearEmbeddings: async () => {},
      cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
      close: async () => {},
    };
  };

  const keywordCalls = { opened: 0, rebuild: 0 };
  const keywordFactory = async () => {
    keywordCalls.opened += 1;
    return {
      rebuildIndex: async () => {
        keywordCalls.rebuild += 1;
      },
      search: async () => [],
      isEmpty: async () => true,
      close: async () => {},
    };
  };

  const result = await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
      qmdEmbedModel: "fake-embed-model",
    },
    qmdFactory,
    keywordFactory,
  );

  assert.equal(result.stats.skippedAttachments, 1);
  assert.equal(qmdCalls.opened, 0);
  assert.equal(qmdCalls.update, 0);
  assert.equal(qmdCalls.listContexts, 0);
  assert.equal(keywordCalls.opened, 0);
  assert.equal(keywordCalls.rebuild, 0);

  const logBody = readFileSync(result.logPath, "utf-8");
  assert.match(logBody, /No catalog changes since last completed sync/);

  const persisted = readCatalogFile(join(indexDir, "catalog.json"));
  assert.ok(persisted.indexesCompletedAt, "expected completion marker to be persisted");
  assert.equal(persisted.indexedQmdEmbedModel, "fake-embed-model");
  assert.equal(persisted.indexerSignature, buildIndexerSignature("fake-embed-model"));
});

test("runSync rebuilds indexes when the qmd embedding model changes since last sync", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-embed-change-"));
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
  const pdfStat = statSync(pdfPath);
  const docKey = sha1("papers/paper.pdf");
  const normalizedPath = join(normalizedDir, `${docKey}.md`);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  writeFileSync(normalizedPath, "Body");
  writeManifestFile(manifestPath, {
    docKey,
    itemKey: "ITEM1",
    title: "Paper",
    authors: ["Author One"],
    filePath: pdfPath,
    normalizedPath,
    blocks: [trivialBlock()],
  });

  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "cite",
        title: "Paper",
        author: [{ family: "One", given: "Author" }],
        file: pdfPath,
        "zotero-item-key": "ITEM1",
      },
    ]),
    "utf-8",
  );

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    indexesCompletedAt: new Date().toISOString(),
    indexedQmdEmbedModel: "old-embed-model",
    indexerSignature: buildIndexerSignature("old-embed-model"),
    entries: [
      {
        docKey,
        itemKey: "ITEM1",
        citationKey: "cite",
        title: "Paper",
        authors: ["One Author"],
        filePath: pdfPath,
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: pdfStat.size,
        mtimeMs: Math.trunc(pdfStat.mtimeMs),
        sourceHash: "existinghash",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath,
        manifestPath,
      },
    ],
  });

  let qmdUpdateCalls = 0;
  let clearCalls = 0;
  const embedOptions: Array<{ force?: boolean } | undefined> = [];
  const qmdFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => {
      qmdUpdateCalls += 1;
      return {};
    },
    embed: async (options?: { force?: boolean }) => {
      embedOptions.push(options);
      return {};
    },
    getStatus: async () => ({
      totalDocuments: 1,
      needsEmbedding: clearCalls > 0 && embedOptions.length === 0 ? 1 : 0,
      hasVectorIndex: embedOptions.length > 0,
      collections: [],
    }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {
      clearCalls += 1;
    },
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });

  await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
      qmdEmbedModel: "new-embed-model",
    },
    qmdFactory,
  );

  assert.equal(qmdUpdateCalls, 1);
  assert.equal(clearCalls, 1);
  assert.deepEqual(embedOptions, [undefined]);
  const persisted = readCatalogFile(join(indexDir, "catalog.json"));
  assert.equal(persisted.indexedQmdEmbedModel, "new-embed-model");
  assert.equal(persisted.indexerSignature, buildIndexerSignature("new-embed-model"));
});

test("runSync rebuilds indexes but preserves embeddings when only the indexer signature changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-indexer-change-"));
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
  const pdfStat = statSync(pdfPath);
  const docKey = sha1("papers/paper.pdf");
  const normalizedPath = join(normalizedDir, `${docKey}.md`);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  writeFileSync(normalizedPath, "Body");
  writeManifestFile(manifestPath, {
    docKey,
    itemKey: "ITEM1",
    title: "Paper",
    authors: ["Author One"],
    filePath: pdfPath,
    normalizedPath,
    blocks: [trivialBlock()],
  });

  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "cite",
        title: "Paper",
        author: [{ family: "One", given: "Author" }],
        file: pdfPath,
        "zotero-item-key": "ITEM1",
      },
    ]),
    "utf-8",
  );

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    indexesCompletedAt: new Date().toISOString(),
    indexedQmdEmbedModel: "same-embed-model",
    indexerSignature: "stale-indexer-signature",
    entries: [
      {
        docKey,
        itemKey: "ITEM1",
        citationKey: "cite",
        title: "Paper",
        authors: ["One Author"],
        filePath: pdfPath,
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: pdfStat.size,
        mtimeMs: Math.trunc(pdfStat.mtimeMs),
        sourceHash: "existinghash",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath,
        manifestPath,
      },
    ],
  });

  let qmdUpdateCalls = 0;
  let clearCalls = 0;
  const embedOptions: Array<{ force?: boolean } | undefined> = [];
  const qmdFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => {
      qmdUpdateCalls += 1;
      return {};
    },
    embed: async (options?: { force?: boolean }) => {
      embedOptions.push(options);
      return {};
    },
    getStatus: async () => ({
      totalDocuments: 1,
      needsEmbedding: clearCalls > 0 && embedOptions.length === 0 ? 1 : 0,
      hasVectorIndex: embedOptions.length > 0,
      collections: [],
    }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {
      clearCalls += 1;
    },
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });

  await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
      qmdEmbedModel: "same-embed-model",
    },
    qmdFactory,
  );

  assert.equal(qmdUpdateCalls, 1);
  assert.equal(clearCalls, 0);
  assert.deepEqual(embedOptions, []);
  const persisted = readCatalogFile(join(indexDir, "catalog.json"));
  assert.equal(persisted.indexedQmdEmbedModel, "same-embed-model");
  assert.equal(persisted.indexerSignature, buildIndexerSignature("same-embed-model"));
});

test("runSync keeps old indexer state in progress catalog until changed qmd embeddings are cleared", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-indexer-progress-"));
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
  const pdfStat = statSync(pdfPath);
  const docKey = sha1("papers/paper.pdf");
  const normalizedPath = join(normalizedDir, `${docKey}.md`);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  writeFileSync(normalizedPath, "Body");
  writeManifestFile(manifestPath, {
    docKey,
    itemKey: "ITEM1",
    title: "Paper",
    authors: ["Author One"],
    filePath: pdfPath,
    normalizedPath,
    blocks: [trivialBlock()],
  });

  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "cite",
        title: "Paper",
        author: [{ family: "One", given: "Author" }],
        file: pdfPath,
        "zotero-item-key": "ITEM1",
      },
    ]),
    "utf-8",
  );

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    indexesCompletedAt: new Date().toISOString(),
    indexedQmdEmbedModel: "old-embed-model",
    indexerSignature: buildIndexerSignature("old-embed-model"),
    entries: [
      {
        docKey,
        itemKey: "ITEM1",
        citationKey: "cite",
        title: "Paper",
        authors: ["One Author"],
        filePath: pdfPath,
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: pdfStat.size,
        mtimeMs: Math.trunc(pdfStat.mtimeMs),
        sourceHash: "existinghash",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath,
        manifestPath,
      },
    ],
  });

  let clearCalls = 0;
  const qmdFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => {
      throw new Error("qmd update interrupted before clear");
    },
    embed: async () => ({}),
    getStatus: async () => ({ totalDocuments: 1, needsEmbedding: 1, hasVectorIndex: true, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {
      clearCalls += 1;
    },
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });

  await assert.rejects(
    runSync(
      {
        bibliographyJsonPath: bibliographyPath,
        attachmentsRoot,
        dataDir,
        qmdEmbedModel: "new-embed-model",
      },
      qmdFactory,
    ),
    /qmd update interrupted before clear/,
  );

  assert.equal(clearCalls, 0);
  const persisted = readCatalogFile(join(indexDir, "catalog.json"));
  assert.equal(persisted.indexedQmdEmbedModel, "old-embed-model");
  assert.equal(persisted.indexerSignature, buildIndexerSignature("old-embed-model"));
  assert.equal(persisted.indexesCompletedAt, undefined);
});

test("runSync does not force re-embed when resuming an interrupted sync with matching indexer state", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-resume-"));
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
  const pdfStat = statSync(pdfPath);
  const docKey = sha1("papers/paper.pdf");
  const normalizedPath = join(normalizedDir, `${docKey}.md`);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  writeFileSync(normalizedPath, "Body");
  writeManifestFile(manifestPath, {
    docKey,
    itemKey: "ITEM1",
    title: "Paper",
    authors: ["Author One"],
    filePath: pdfPath,
    normalizedPath,
    blocks: [trivialBlock()],
  });

  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "cite",
        title: "Paper",
        author: [{ family: "One", given: "Author" }],
        file: pdfPath,
        "zotero-item-key": "ITEM1",
      },
    ]),
    "utf-8",
  );

  // Simulate the on-disk state after an interrupted sync: progress catalog
  // has recorded the active embed model and indexer signature, but
  // `indexesCompletedAt` is absent because the run was killed.
  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    indexedQmdEmbedModel: "resumable-embed-model",
    indexerSignature: buildIndexerSignature("resumable-embed-model"),
    entries: [
      {
        docKey,
        itemKey: "ITEM1",
        citationKey: "cite",
        title: "Paper",
        authors: ["One Author"],
        filePath: pdfPath,
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: pdfStat.size,
        mtimeMs: Math.trunc(pdfStat.mtimeMs),
        sourceHash: "existinghash",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath,
        manifestPath,
      },
    ],
  });

  const embedOptions: Array<{ force?: boolean } | undefined> = [];
  let statusCalls = 0;
  const qmdFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async (options?: { force?: boolean }) => {
      embedOptions.push(options);
      return {};
    },
    // Simulate one doc still needing embedding (as would be true after an
    // interrupted sync), then zero after a single incremental pass.
    getStatus: async () => {
      statusCalls += 1;
      return {
        totalDocuments: 1,
        needsEmbedding: statusCalls === 1 ? 1 : 0,
        hasVectorIndex: true,
        collections: [],
      };
    },
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });

  await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
      qmdEmbedModel: "resumable-embed-model",
    },
    qmdFactory,
  );

  // Resume must do an incremental embed, not a force. `force: true` would
  // trigger `clearAllEmbeddings` inside qmd and discard the partial work.
  assert.equal(embedOptions.length, 1);
  assert.equal(embedOptions[0], undefined);
});

test("runSync migrates cached artifacts when an attachment is renamed inside attachmentsRoot", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-rename-"));
  const attachmentsRoot = join(root, "attachments");
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  const normalizedDir = join(dataDir, "normalized");
  mkdirSync(join(attachmentsRoot, "papers"), { recursive: true });
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });
  mkdirSync(normalizedDir, { recursive: true });

  // Seed the filesystem as if an earlier sync had indexed papers/old.pdf.
  const oldRel = "papers/old.pdf";
  const newRel = "papers/renamed.pdf";
  const oldDocKey = sha1(oldRel);
  const newDocKey = sha1(newRel);
  assert.notEqual(oldDocKey, newDocKey);
  const newPath = join(attachmentsRoot, newRel);
  writeFileSync(newPath, "pdf-body");
  // Preserve a stable mtime so the (itemKey,size,mtimeMs) rename key matches.
  const frozenMtimeMs = Date.UTC(2025, 5, 1);
  utimesSync(newPath, new Date(frozenMtimeMs), new Date(frozenMtimeMs));
  const stat = statSync(newPath);

  const oldNormalizedPath = join(normalizedDir, `${oldDocKey}.md`);
  const oldManifestPath = join(manifestsDir, `${oldDocKey}${MANIFEST_EXT}`);
  writeFileSync(oldNormalizedPath, "Body from the original extraction");
  writeManifestFile(oldManifestPath, {
    docKey: oldDocKey,
    itemKey: "ITEM1",
    title: "Paper",
    authors: ["A Author"],
    filePath: `${attachmentsRoot}/${oldRel}`, // points at a path that no longer exists
    normalizedPath: oldNormalizedPath,
    blocks: [trivialBlock()],
  });

  // Completion markers plus a matching signature so the embed is not forced;
  // this isolates the rename behaviour we are testing from the separate
  // "invalidate on indexer change" path exercised by other tests.
  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    indexesCompletedAt: new Date().toISOString(),
    indexedQmdEmbedModel: "qmd-default",
    indexerSignature: buildIndexerSignature("qmd-default"),
    entries: [
      {
        docKey: oldDocKey,
        itemKey: "ITEM1",
        citationKey: "cite",
        title: "Paper",
        authors: ["A Author"],
        filePath: `~/(stale)/${oldRel}`,
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
        sourceHash: "pre-existing-source-hash",
        lastIndexedAt: "2025-06-01T00:00:00.000Z",
        normalizedPath: oldNormalizedPath,
        manifestPath: oldManifestPath,
      },
    ],
  });

  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "cite",
        title: "Paper",
        author: [{ family: "A", given: "Author" }],
        file: newPath,
        "zotero-item-key": "ITEM1",
      },
    ]),
    "utf-8",
  );

  const extractCalls: unknown[] = [];
  const embedOptions: Array<{ force?: boolean } | undefined> = [];
  const qmdFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async (options?: { force?: boolean }) => {
      embedOptions.push(options);
      return {};
    },
    getStatus: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });
  const extractBatchFn = async (batch: unknown[]) => {
    extractCalls.push(batch);
    return new Map();
  };

  const result = await runSync(
    { bibliographyJsonPath: bibliographyPath, attachmentsRoot, dataDir },
    qmdFactory,
    undefined,
    extractBatchFn as never,
  );

  // No re-extraction should run; the artifacts are moved, not rebuilt.
  assert.equal(extractCalls.length, 0);
  // And no forced re-embed — the content hash is unchanged so stored vectors
  // still apply to the new docKey.
  assert.ok(embedOptions.every((o) => !o?.force), "no force embed should occur on rename");

  // Artifacts moved to the new docKey.
  assert.ok(!existsSync(oldNormalizedPath), "old normalized file must be gone");
  assert.ok(!existsSync(oldManifestPath), "old manifest file must be gone");
  const newNormalizedPath = join(normalizedDir, `${newDocKey}.md`);
  const newManifestPath = join(manifestsDir, `${newDocKey}${MANIFEST_EXT}`);
  assert.ok(existsSync(newNormalizedPath), "normalized artifact must be present under new docKey");
  assert.ok(existsSync(newManifestPath), "manifest artifact must be present under new docKey");

  // Manifest stored docKey/filePath/normalizedPath must reflect the new identity.
  const migratedManifest = readManifestFile(newManifestPath);
  assert.equal(migratedManifest.docKey, newDocKey);
  assert.equal(migratedManifest.filePath, newPath);
  assert.equal(migratedManifest.normalizedPath, newNormalizedPath);

  // Catalog gets exactly one ready entry under the new docKey, inherits
  // previous sourceHash/lastIndexedAt, and the old entry is gone.
  const persisted = readCatalogFile(join(indexDir, "catalog.json"));
  assert.equal(persisted.entries.length, 1);
  assert.equal(persisted.entries[0]!.docKey, newDocKey);
  assert.equal(persisted.entries[0]!.sourceHash, "pre-existing-source-hash");
  assert.equal(persisted.entries[0]!.lastIndexedAt, "2025-06-01T00:00:00.000Z");
  assert.equal(result.stats.skippedAttachments, 1);
  assert.equal(result.stats.removedAttachments, 0);

  const logBody = readFileSync(result.logPath, "utf-8");
  assert.match(logBody, /migrated artifacts from renamed attachment/);
});

test("runSync re-extracts renamed attachments when cached artifacts are not reusable", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-rename-bad-cache-"));
  const attachmentsRoot = join(root, "attachments");
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  const normalizedDir = join(dataDir, "normalized");
  mkdirSync(join(attachmentsRoot, "papers"), { recursive: true });
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });
  mkdirSync(normalizedDir, { recursive: true });

  const oldRel = "papers/old.pdf";
  const newRel = "papers/renamed.pdf";
  const oldDocKey = sha1(oldRel);
  const newDocKey = sha1(newRel);
  const newPath = join(attachmentsRoot, newRel);
  writeFileSync(newPath, "pdf-body");
  const frozenMtimeMs = Date.UTC(2025, 5, 1);
  utimesSync(newPath, new Date(frozenMtimeMs), new Date(frozenMtimeMs));
  const stat = statSync(newPath);

  const oldNormalizedPath = join(normalizedDir, `${oldDocKey}.md`);
  const oldManifestPath = join(manifestsDir, `${oldDocKey}${MANIFEST_EXT}`);
  writeFileSync(oldNormalizedPath, "Body from a corrupt cache");
  writeManifestFile(oldManifestPath, {
    docKey: oldDocKey,
    itemKey: "ITEM1",
    title: "Paper",
    authors: ["A Author"],
    filePath: join(attachmentsRoot, oldRel),
    normalizedPath: oldNormalizedPath,
    blocks: [],
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    indexesCompletedAt: new Date().toISOString(),
    indexedQmdEmbedModel: "qmd-default",
    indexerSignature: buildIndexerSignature("qmd-default"),
    entries: [
      {
        docKey: oldDocKey,
        itemKey: "ITEM1",
        citationKey: "cite",
        title: "Paper",
        authors: ["A Author"],
        filePath: join(attachmentsRoot, oldRel),
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
        sourceHash: "pre-existing-source-hash",
        lastIndexedAt: "2025-06-01T00:00:00.000Z",
        normalizedPath: oldNormalizedPath,
        manifestPath: oldManifestPath,
      },
    ],
  });

  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "cite",
        title: "Paper",
        author: [{ family: "A", given: "Author" }],
        file: newPath,
        "zotero-item-key": "ITEM1",
      },
    ]),
    "utf-8",
  );

  const qmdFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });
  const extractCalls: unknown[] = [];
  const extractBatchFn = async (batch: Array<{ docKey: string; filePath: string; itemKey: string }>) => {
    extractCalls.push(batch);
    const attachment = batch[0]!;
    const normalizedPath = join(normalizedDir, `${attachment.docKey}.md`);
    const manifestPath = join(manifestsDir, `${attachment.docKey}${MANIFEST_EXT}`);
    writeFileSync(normalizedPath, "Fresh extraction");
    writeManifestFile(manifestPath, {
      docKey: attachment.docKey,
      itemKey: attachment.itemKey,
      title: "Paper",
      authors: ["A Author"],
      filePath: attachment.filePath,
      normalizedPath,
      blocks: [trivialBlock()],
    });
    return new Map([[attachment.docKey, { normalizedPath, manifestPath }]]);
  };

  await runSync(
    { bibliographyJsonPath: bibliographyPath, attachmentsRoot, dataDir },
    qmdFactory,
    undefined,
    extractBatchFn as never,
    () => {},
  );

  assert.equal(extractCalls.length, 1);
  assert.ok(!existsSync(oldNormalizedPath), "stale docKey normalized cache should be pruned");
  assert.ok(!existsSync(oldManifestPath), "stale docKey manifest cache should be pruned");
  assert.equal(readFileSync(join(normalizedDir, `${newDocKey}.md`), "utf-8"), "Fresh extraction");
});

test("runSync re-extracts renamed attachments when rename candidates are ambiguous", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-rename-ambiguous-"));
  const attachmentsRoot = join(root, "attachments");
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  const normalizedDir = join(dataDir, "normalized");
  mkdirSync(join(attachmentsRoot, "papers"), { recursive: true });
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });
  mkdirSync(normalizedDir, { recursive: true });

  const oldRels = ["papers/old-a.pdf", "papers/old-b.pdf"];
  const newRel = "papers/renamed.pdf";
  const newDocKey = sha1(newRel);
  const newPath = join(attachmentsRoot, newRel);
  writeFileSync(newPath, "pdf-body");
  const frozenMtimeMs = Date.UTC(2025, 5, 1);
  utimesSync(newPath, new Date(frozenMtimeMs), new Date(frozenMtimeMs));
  const stat = statSync(newPath);

  const previousEntries = oldRels.map((oldRel, i) => {
    const oldDocKey = sha1(oldRel);
    const normalizedPath = join(normalizedDir, `${oldDocKey}.md`);
    const manifestPath = join(manifestsDir, `${oldDocKey}${MANIFEST_EXT}`);
    writeFileSync(normalizedPath, `Old body ${i + 1}`);
    writeManifestFile(manifestPath, {
      docKey: oldDocKey,
      itemKey: "ITEM1",
      title: "Paper",
      authors: ["A Author"],
      filePath: join(attachmentsRoot, oldRel),
      normalizedPath,
      blocks: [trivialBlock()],
    });
    return {
      docKey: oldDocKey,
      itemKey: "ITEM1",
      citationKey: "cite",
      title: "Paper",
      authors: ["A Author"],
      filePath: join(attachmentsRoot, oldRel),
      fileExt: "pdf" as const,
      exists: true,
      supported: true,
      extractStatus: "ready" as const,
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
      sourceHash: `pre-existing-source-hash-${i + 1}`,
      lastIndexedAt: "2025-06-01T00:00:00.000Z",
      normalizedPath,
      manifestPath,
    };
  });

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    indexesCompletedAt: new Date().toISOString(),
    indexedQmdEmbedModel: "qmd-default",
    indexerSignature: buildIndexerSignature("qmd-default"),
    entries: previousEntries,
  });

  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "cite",
        title: "Paper",
        author: [{ family: "A", given: "Author" }],
        file: newPath,
        "zotero-item-key": "ITEM1",
      },
    ]),
    "utf-8",
  );

  const qmdFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });
  const extractCalls: unknown[] = [];
  const extractBatchFn = async (batch: Array<{ docKey: string; filePath: string; itemKey: string }>) => {
    extractCalls.push(batch);
    const attachment = batch[0]!;
    const normalizedPath = join(normalizedDir, `${attachment.docKey}.md`);
    const manifestPath = join(manifestsDir, `${attachment.docKey}${MANIFEST_EXT}`);
    writeFileSync(normalizedPath, "Fresh extraction for ambiguous rename");
    writeManifestFile(manifestPath, {
      docKey: attachment.docKey,
      itemKey: attachment.itemKey,
      title: "Paper",
      authors: ["A Author"],
      filePath: attachment.filePath,
      normalizedPath,
      blocks: [trivialBlock()],
    });
    return new Map([[attachment.docKey, { normalizedPath, manifestPath }]]);
  };

  await runSync(
    { bibliographyJsonPath: bibliographyPath, attachmentsRoot, dataDir },
    qmdFactory,
    undefined,
    extractBatchFn as never,
    () => {},
  );

  assert.equal(extractCalls.length, 1);
  assert.ok(!existsSync(previousEntries[0]!.normalizedPath));
  assert.ok(!existsSync(previousEntries[1]!.normalizedPath));
  assert.equal(
    readFileSync(join(normalizedDir, `${newDocKey}.md`), "utf-8"),
    "Fresh extraction for ambiguous rename",
  );
});

test("runSync asks qmd to clean orphaned residue on the happy path", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-cleanup-"));
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

  let cleanupCalls = 0;
  const qmdFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => {
      cleanupCalls += 1;
      return {
        deletedInactiveDocuments: 2,
        cleanedOrphanedContent: 3,
        cleanedOrphanedVectors: 42,
      };
    },
    close: async () => {},
  });

  const result = await runSync(
    { bibliographyJsonPath: bibliographyPath, attachmentsRoot, dataDir },
    qmdFactory,
  );

  assert.equal(cleanupCalls, 1);
  const logBody = readFileSync(result.logPath, "utf-8");
  assert.match(logBody, /Cleaned qmd residue: 2 inactive doc\(s\), 3 content row\(s\), 42 vector\(s\)/);
});

test("runSync skips qmd context writes when existing contexts already match", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-ctx-noop-"));
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
  const pdfStat = statSync(pdfPath);
  const docKey = sha1("papers/paper.pdf");
  const normalizedPath = join(normalizedDir, `${docKey}.md`);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  writeFileSync(normalizedPath, "Body");
  writeManifestFile(manifestPath, {
    docKey,
    itemKey: "ITEM1",
    title: "Paper",
    authors: ["Author One"],
    filePath: pdfPath,
    normalizedPath,
    blocks: [trivialBlock()],
  });

  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "cite",
        title: "Paper",
        author: [{ family: "One", given: "Author" }],
        file: pdfPath,
        "zotero-item-key": "ITEM1",
      },
    ]),
    "utf-8",
  );

  const matchingEntry = {
    docKey,
    itemKey: "ITEM1",
    citationKey: "cite",
    title: "Paper",
    authors: ["One Author"],
    filePath: pdfPath,
    fileExt: "pdf" as const,
    exists: true,
    supported: true,
    extractStatus: "ready" as const,
    size: pdfStat.size,
    mtimeMs: Math.trunc(pdfStat.mtimeMs),
    sourceHash: "existinghash",
    lastIndexedAt: new Date().toISOString(),
    normalizedPath,
    manifestPath,
  };
  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [matchingEntry],
  });

  const expectedContext = buildContext(matchingEntry);
  const calls = { added: 0, removed: 0 };
  const fakeFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    listContexts: async () => [
      { collection: "library", path: `/${docKey}.md`, context: expectedContext },
    ],
    addContext: async () => {
      calls.added += 1;
      return true;
    },
    removeContext: async () => {
      calls.removed += 1;
      return true;
    },
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });

  await runSync(
    { bibliographyJsonPath: bibliographyPath, attachmentsRoot, dataDir },
    fakeFactory,
  );

  assert.equal(calls.added, 0);
  assert.equal(calls.removed, 0);
});

test("runSync resumes from existing normalized and manifest outputs when catalog state is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-resume-"));
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
  const docKey = sha1("papers/paper.pdf");
  const normalizedPath = join(normalizedDir, `${docKey}.md`);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  writeFileSync(normalizedPath, "Body", "utf-8");
  writeManifestFile(
    manifestPath,
    {
      docKey,
      itemKey: "ITEM1",
      title: "Paper",
      authors: ["A Author"],
      filePath: pdfPath,
      normalizedPath,
      blocks: [trivialBlock()],
    },
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

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [],
  });

  let extractCalls = 0;
  const fakeFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });
  const fakeExtractBatch = async () => {
    extractCalls += 1;
    return new Map();
  };

  const result = await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
    undefined,
    fakeExtractBatch,
    () => {},
  );

  assert.equal(extractCalls, 0);
  assert.equal(result.stats.skippedAttachments, 1);
  assert.equal(result.stats.updatedAttachments, 0);
  assert.equal(result.stats.readyAttachments, 1);

  const nextCatalog = readCatalogFile(join(indexDir, "catalog.json"));
  assert.equal(nextCatalog.entries[0]?.extractStatus, "ready");
  assert.equal(nextCatalog.entries[0]?.normalizedPath, normalizedPath);
  assert.equal(nextCatalog.entries[0]?.manifestPath, manifestPath);
  assert.ok(nextCatalog.indexedQmdEmbedModel, "expected effective qmd embed model to be persisted");
  assert.equal(nextCatalog.indexerSignature, buildIndexerSignature(nextCatalog.indexedQmdEmbedModel));
});

test("runSync re-extracts attachments when fallback normalized output is empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-empty-fallback-"));
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
  const docKey = sha1("papers/paper.pdf");
  const normalizedPath = join(normalizedDir, `${docKey}.md`);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  writeFileSync(normalizedPath, "", "utf-8");
  writeManifestFile(
    manifestPath,
    {
      docKey,
      itemKey: "ITEM1",
      title: "Paper",
      authors: ["A Author"],
      filePath: pdfPath,
      normalizedPath,
      blocks: [],
    },
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

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [],
  });

  let extractCalls = 0;
  const fakeFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });
  const fakeExtractBatch = async (batch: Array<{ docKey: string; filePath: string; itemKey: string }>) => {
    extractCalls += 1;
    const attachment = batch[0]!;
    writeFileSync(normalizedPath, "Recovered body", "utf-8");
    writeManifestFile(
      manifestPath,
      {
        docKey: attachment.docKey,
        itemKey: attachment.itemKey,
        title: "Paper",
        authors: ["A Author"],
        filePath: attachment.filePath,
        normalizedPath,
        blocks: [],
      },
    );
    return new Map([[attachment.docKey, { manifestPath, normalizedPath }]]);
  };

  const result = await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
    undefined,
    fakeExtractBatch,
    () => {},
  );

  assert.equal(extractCalls, 1);
  assert.equal(result.stats.readyAttachments, 1);
  assert.equal(result.stats.updatedAttachments, 1);
  assert.equal(result.stats.skippedAttachments, 0);
  assert.equal(readFileSync(normalizedPath, "utf-8"), "Recovered body");
});

test("runSync re-extracts when the source file changed even if stale cache matches the docKey", async () => {
  // Regression: when a user modifies an attachment in place (e.g. running OCR
  // over a scanned PDF), sync must re-extract. Previously the fallback
  // artifacts check short-circuited this path: if `normalized/<docKey>.md` and
  // the manifest happened to exist from a prior extraction, sync reused them
  // and left the freshly-changed PDF indexed from its stale output.
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-stale-cache-"));
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
  // "OCR'd" PDF is larger than what the previous catalog recorded.
  writeFileSync(pdfPath, "ocr-enlarged-pdf-bytes");
  const currentStat = statSync(pdfPath);
  const docKey = sha1("papers/paper.pdf");
  const normalizedPath = join(normalizedDir, `${docKey}.md`);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  // Stale cache from a previous, pre-OCR extraction.
  writeFileSync(normalizedPath, "Stale body", "utf-8");
  writeManifestFile(manifestPath, {
    docKey,
    itemKey: "ITEM1",
    title: "Paper",
    authors: ["A Author"],
    filePath: pdfPath,
    normalizedPath,
    blocks: [trivialBlock()],
  });

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

  // Previous catalog records a smaller/older file than what is on disk now.
  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    indexesCompletedAt: new Date().toISOString(),
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
        size: 3,
        mtimeMs: Math.trunc(currentStat.mtimeMs) - 10_000,
        sourceHash: "stalehash",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath,
        manifestPath,
      },
    ],
  });

  let extractCalls = 0;
  const fakeFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });
  const fakeExtractBatch = async (batch: Array<{ docKey: string; filePath: string; itemKey: string }>) => {
    extractCalls += 1;
    const attachment = batch[0]!;
    writeFileSync(normalizedPath, "Fresh body", "utf-8");
    writeManifestFile(manifestPath, {
      docKey: attachment.docKey,
      itemKey: attachment.itemKey,
      title: "Paper",
      authors: ["A Author"],
      filePath: attachment.filePath,
      normalizedPath,
      blocks: [trivialBlock()],
    });
    return new Map([[attachment.docKey, { manifestPath, normalizedPath }]]);
  };

  const result = await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
    undefined,
    fakeExtractBatch,
    () => {},
  );

  assert.equal(extractCalls, 1, "stale cache must not short-circuit re-extraction");
  assert.equal(result.stats.updatedAttachments, 1);
  assert.equal(result.stats.skippedAttachments, 0);
  assert.equal(readFileSync(normalizedPath, "utf-8"), "Fresh body");
});

test("runSync re-extracts ready entries whose cached manifest has zero blocks", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-empty-blocks-"));
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
  const docKey = sha1("papers/paper.pdf");
  const normalizedPath = join(normalizedDir, `${docKey}.md`);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  // Non-empty normalized.md (passes the empty-normalized guard) + manifest with no blocks.
  writeFileSync(normalizedPath, "Stale body", "utf-8");
  writeManifestFile(
    manifestPath,
    {
      docKey,
      itemKey: "ITEM1",
      title: "Paper",
      authors: ["A Author"],
      filePath: pdfPath,
      normalizedPath,
      blocks: [],
    },
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

  // Catalog says the entry is "ready" with matching size/mtime, so without the
  // empty-blocks guard sync would happily reuse the empty manifest.
  writeCatalogFile(join(indexDir, "catalog.json"), {
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
        sourceHash: "stalehash",
        lastIndexedAt: new Date().toISOString(),
        normalizedPath,
        manifestPath,
      },
    ],
  });

  let extractCalls = 0;
  const fakeFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });
  const fakeExtractBatch = async (batch: Array<{ docKey: string; filePath: string; itemKey: string }>) => {
    extractCalls += 1;
    const attachment = batch[0]!;
    writeFileSync(normalizedPath, "Recovered body", "utf-8");
    writeManifestFile(
      manifestPath,
      {
        docKey: attachment.docKey,
        itemKey: attachment.itemKey,
        title: "Paper",
        authors: ["A Author"],
        filePath: attachment.filePath,
        normalizedPath,
        blocks: [
          {
            blockIndex: 0,
            blockType: "paragraph",
            sectionPath: ["Body"],
            text: "Recovered body",
            charStart: 0,
            charEnd: 14,
            lineStart: 1,
            lineEnd: 1,
            isReferenceLike: false,
          },
        ],
      },
    );
    return new Map([[attachment.docKey, { manifestPath, normalizedPath }]]);
  };

  const result = await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
    undefined,
    fakeExtractBatch,
    () => {},
  );

  assert.equal(extractCalls, 1);
  assert.equal(result.stats.readyAttachments, 1);
  assert.equal(result.stats.updatedAttachments, 1);
  assert.equal(result.stats.skippedAttachments, 0);
  const refreshed = readManifestFile(manifestPath);
  assert.equal(refreshed.blocks.length, 1);
});

test("runSync keeps embedding until qmd no longer reports pending documents", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-embed-loop-"));
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
  const docKey = sha1("papers/paper.pdf");
  const normalizedPath = join(normalizedDir, `${docKey}.md`);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  writeFileSync(normalizedPath, "Body", "utf-8");
  writeManifestFile(
    manifestPath,
    {
      docKey,
      itemKey: "ITEM1",
      title: "Paper",
      authors: ["A"],
      filePath: pdfPath,
      normalizedPath,
      blocks: [trivialBlock()],
    },
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

  writeCatalogFile(join(indexDir, "catalog.json"), {
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
  });

  let embedCalls = 0;
  let needsEmbedding = 5;
  const fakeFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => {
      embedCalls += 1;
      needsEmbedding = Math.max(0, needsEmbedding - 2);
      return {};
    },
    getStatus: async () => ({
      totalDocuments: 1,
      needsEmbedding,
      hasVectorIndex: needsEmbedding < 5,
      collections: [],
    }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });

  await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
  );

  assert.equal(embedCalls, 3);
  assert.equal(needsEmbedding, 0);
});

test("runSync marks empty txt extraction output as error", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-empty-txt-"));
  const attachmentsRoot = join(root, "attachments");
  const dataDir = join(root, "data");
  mkdirSync(join(attachmentsRoot, "notes"), { recursive: true });

  const txtPath = join(attachmentsRoot, "notes", "empty.txt");
  writeFileSync(txtPath, "", "utf-8");

  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "cite",
        title: "Empty Transcript",
        author: [{ family: "A", given: "Author" }],
        file: txtPath,
        "zotero-item-key": "ITEM1",
      },
    ]),
    "utf-8",
  );

  const fakeFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ totalDocuments: 0, needsEmbedding: 0, hasVectorIndex: false, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });

  const result = await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
    undefined,
    () => Promise.resolve(new Map()),
    () => {},
  );

  assert.equal(result.stats.readyAttachments, 0);
  assert.equal(result.stats.errorAttachments, 1);

  const catalog = readCatalogFile(join(dataDir, "index", "catalog.json"));
  assert.equal(catalog.entries[0]?.extractStatus, "error");
  assert.match(catalog.entries[0]?.error || "", /Extracted output was empty/);
});

test("runSync indexes txt attachments without Java extraction", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-txt-"));
  const attachmentsRoot = join(root, "attachments");
  const dataDir = join(root, "data");
  mkdirSync(join(attachmentsRoot, "notes"), { recursive: true });

  const txtPath = join(attachmentsRoot, "notes", "transcript.txt");
  writeFileSync(txtPath, "第一段\n\n第二段", "utf-8");

  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "cite",
        title: "Transcript",
        author: [{ family: "A", given: "Author" }],
        file: txtPath,
        "zotero-item-key": "ITEM1",
      },
    ]),
    "utf-8",
  );

  let extractBatchCalls = 0;
  const fakeFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });
  const fakeExtractBatch = async () => {
    extractBatchCalls += 1;
    return new Map();
  };

  const result = await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
    undefined,
    fakeExtractBatch,
    () => {},
  );

  assert.equal(extractBatchCalls, 0);
  assert.equal(result.stats.readyAttachments, 1);
  assert.equal(result.stats.unsupportedAttachments, 0);

  const catalog = readCatalogFile(join(dataDir, "index", "catalog.json"));
  assert.equal(catalog.entries[0]?.fileExt, "txt");
  assert.equal(catalog.entries[0]?.extractStatus, "ready");

  const normalizedPath = catalog.entries[0]?.normalizedPath;
  const manifestPath = catalog.entries[0]?.manifestPath;
  assert.equal(typeof normalizedPath, "string");
  assert.equal(typeof manifestPath, "string");
  assert.match(readFileSync(normalizedPath!, "utf-8"), /第一段/);
  assert.match(JSON.stringify(readManifestFile(manifestPath!)), /第二段/);
});

test("runSync reuses a ready index when bibliography paths come from another machine", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-relocate-"));
  const attachmentsRoot = join(root, "miniagent", "Zotero");
  const bibliographyRoot = join(root, "rentao", "Zotero");
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
  const foreignPath = join(bibliographyRoot, "papers", "paper.pdf");
  const docKey = sha1("papers/paper.pdf");
  const normalizedPath = join(normalizedDir, `${docKey}.md`);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
  writeFileSync(normalizedPath, "Body");
  writeManifestFile(
    manifestPath,
    {
      docKey,
      itemKey: "ITEM1",
      title: "Paper",
      authors: ["A"],
      filePath: foreignPath,
      normalizedPath,
      blocks: [trivialBlock()],
    },
  );

  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "cite",
        title: "Paper",
        author: [{ family: "A", given: "Author" }],
        file: foreignPath,
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
        filePath: foreignPath,
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
  };

  let needsEmbedding = 1;
  const fakeFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => {
      calls.update += 1;
      return {};
    },
    embed: async () => {
      calls.embed += 1;
      needsEmbedding = 0;
      return {};
    },
    getStatus: async () => ({ totalDocuments: 1, needsEmbedding, hasVectorIndex: needsEmbedding === 0, collections: [] }),
    listContexts: async () => [{ collection: "library", path: "/old.md", context: "old" }],
    addContext: async () => {
      calls.added += 1;
      return true;
    },
    removeContext: async () => {
      calls.removed += 1;
      return true;
    },
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
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
  assert.equal(result.stats.readyAttachments, 1);
  assert.equal(calls.update, 1);
  assert.equal(calls.embed, 1);
  assert.equal(calls.removed, 1);
  assert.equal(calls.added, 1);

  const nextCatalog = readCatalogFile(join(indexDir, "catalog.json"));
  assert.equal(nextCatalog.entries[0]?.filePath, pdfPath);
  assert.equal(nextCatalog.entries[0]?.docKey, docKey);
});

test("catalog storage uses home-relative paths and reads them back as local paths", () => {
  const root = mkdtempSync(join(homedir(), ".zotagent-catalog-home-"));
  try {
    const dataDir = join(root, "Zotagent");
    const indexDir = join(dataDir, "index");
    const normalizedDir = join(dataDir, "normalized");
    const manifestsDir = join(dataDir, "manifests");
    mkdirSync(indexDir, { recursive: true });
    mkdirSync(normalizedDir, { recursive: true });
    mkdirSync(manifestsDir, { recursive: true });

    const docKey = "7".repeat(40);
    const pdfPath = join(root, "Zotero", "paper.pdf");
    const normalizedPath = join(normalizedDir, `${docKey}.md`);
    const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
    mkdirSync(join(root, "Zotero"), { recursive: true });
    writeFileSync(pdfPath, "pdf");
    writeFileSync(normalizedPath, "Body");
    writeFileSync(manifestPath, "{}");

    const catalogPath = join(indexDir, "catalog.json");
    const homeRelativeCatalogPath = catalogPath.replace(homedir(), "~");
    writeCatalogFile(homeRelativeCatalogPath, {
      version: 1,
      generatedAt: new Date().toISOString(),
      entries: [
        {
          docKey,
          itemKey: "ITEM1",
          title: "Paper",
          authors: [],
          filePath: pdfPath,
          fileExt: "pdf",
          exists: true,
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

    const raw = JSON.parse(readFileSync(catalogPath, "utf-8")) as CatalogFile;
    assert.match(raw.entries[0]!.filePath, /^~\//u);
    assert.match(raw.entries[0]!.normalizedPath!, /^~\//u);
    assert.match(raw.entries[0]!.manifestPath!, /^~\//u);

    const hydrated = readCatalogFile(homeRelativeCatalogPath);
    assert.equal(hydrated.entries[0]?.filePath, pdfPath);
    assert.equal(hydrated.entries[0]?.normalizedPath, normalizedPath);
    assert.equal(hydrated.entries[0]?.manifestPath, manifestPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readCatalogFile relocates stale Mac home paths to the current iCloud dataDir artifacts", () => {
  const root = mkdtempSync(join(homedir(), ".zotagent-catalog-relocate-"));
  try {
    const dataDir = join(root, "Library", "Mobile Documents", "com~apple~CloudDocs", "Zotagent");
    const zoteroRoot = join(root, "Library", "Mobile Documents", "com~apple~CloudDocs", "Zotero");
    const indexDir = join(dataDir, "index");
    const normalizedDir = join(dataDir, "normalized");
    const manifestsDir = join(dataDir, "manifests");
    mkdirSync(indexDir, { recursive: true });
    mkdirSync(normalizedDir, { recursive: true });
    mkdirSync(manifestsDir, { recursive: true });
    mkdirSync(zoteroRoot, { recursive: true });

    const docKey = "8".repeat(40);
    const pdfPath = join(zoteroRoot, "paper.pdf");
    const normalizedPath = join(normalizedDir, `${docKey}.md`);
    const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
    writeFileSync(pdfPath, "pdf");
    writeFileSync(normalizedPath, "Body");
    writeFileSync(manifestPath, "{}");

    const staleHomePrefix = "/Users/miniagent";
    const localHomePrefix = homedir();
    const stalePdfPath = pdfPath.replace(localHomePrefix, staleHomePrefix);
    const staleNormalizedPath = normalizedPath.replace(localHomePrefix, staleHomePrefix);
    const staleManifestPath = manifestPath.replace(localHomePrefix, staleHomePrefix);

    writeFileSync(
      join(indexDir, "catalog.json"),
      JSON.stringify(
        {
          version: 1,
          generatedAt: new Date().toISOString(),
          entries: [
            {
              docKey,
              itemKey: "ITEM1",
              title: "Paper",
              authors: [],
              filePath: stalePdfPath,
              fileExt: "pdf",
              exists: true,
              supported: true,
              extractStatus: "ready",
              size: 1,
              mtimeMs: 1,
              sourceHash: "hash",
              lastIndexedAt: new Date().toISOString(),
              normalizedPath: staleNormalizedPath,
              manifestPath: staleManifestPath,
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const hydrated = readCatalogFile(join(indexDir, "catalog.json"));
    assert.equal(hydrated.entries[0]?.filePath, pdfPath);
    assert.equal(hydrated.entries[0]?.normalizedPath, normalizedPath);
    assert.equal(hydrated.entries[0]?.manifestPath, manifestPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readCatalogFile redirects cache paths outside the current dataDir to the fallback path", () => {
  // Regression: when a catalog is cloned from a backup (or carries paths from
  // an earlier dataDir location), its `manifestPath` / `normalizedPath` may
  // still point into the old dataDir. If those files still exist there,
  // hydration used to keep the foreign path, and sync would silently reuse
  // cache from outside the current dataDir. That couples two installations
  // and causes confusing staleness. Hydration must redirect to the current
  // dataDir's canonical path; sync will then decide reusability against that
  // path alone.
  const root = mkdtempSync(join(tmpdir(), "zotagent-catalog-foreign-dir-"));
  try {
    const foreignDataDir = join(root, "foreign-data");
    const currentDataDir = join(root, "current-data");
    const foreignIndex = join(foreignDataDir, "index");
    const currentIndex = join(currentDataDir, "index");
    const foreignNormalized = join(foreignDataDir, "normalized");
    const foreignManifests = join(foreignDataDir, "manifests");
    const currentNormalized = join(currentDataDir, "normalized");
    const currentManifests = join(currentDataDir, "manifests");
    mkdirSync(foreignIndex, { recursive: true });
    mkdirSync(foreignNormalized, { recursive: true });
    mkdirSync(foreignManifests, { recursive: true });
    mkdirSync(currentIndex, { recursive: true });
    mkdirSync(currentNormalized, { recursive: true });
    mkdirSync(currentManifests, { recursive: true });

    const docKey = "9".repeat(40);
    // Populate the foreign dataDir with cache files (simulating an old backup
    // the user happens to still have lying around).
    writeFileSync(join(foreignNormalized, `${docKey}.md`), "Foreign body");
    writeFileSync(join(foreignManifests, `${docKey}${MANIFEST_EXT}`), "{}");

    const foreignNormalizedPath = join(foreignNormalized, `${docKey}.md`);
    const foreignManifestPath = join(foreignManifests, `${docKey}${MANIFEST_EXT}`);
    const expectedFallbackNormalizedPath = join(currentNormalized, `${docKey}.md`);
    const expectedFallbackManifestPath = join(currentManifests, `${docKey}${MANIFEST_EXT}`);

    writeFileSync(
      join(currentIndex, "catalog.json"),
      JSON.stringify(
        {
          version: 1,
          generatedAt: new Date().toISOString(),
          entries: [
            {
              docKey,
              itemKey: "ITEM1",
              title: "Paper",
              authors: [],
              filePath: "/irrelevant.pdf",
              fileExt: "pdf",
              exists: true,
              supported: true,
              extractStatus: "ready",
              size: 1,
              mtimeMs: 1,
              sourceHash: "hash",
              lastIndexedAt: new Date().toISOString(),
              normalizedPath: foreignNormalizedPath,
              manifestPath: foreignManifestPath,
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const hydrated = readCatalogFile(join(currentIndex, "catalog.json"));
    // Even though the foreign paths exist on disk, hydration must point the
    // entry at the current dataDir's path.
    assert.equal(hydrated.entries[0]?.normalizedPath, expectedFallbackNormalizedPath);
    assert.equal(hydrated.entries[0]?.manifestPath, expectedFallbackManifestPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSync prunes cached outputs when attachment disappears from the current catalog", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-stale-"));
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
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);
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
    getStatus: async () => ({ totalDocuments: 0, needsEmbedding: 0, hasVectorIndex: false, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
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

test("runSync reuses cached outputs after an attachment temporarily disappears", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-resume-missing-"));
  const attachmentsRoot = join(root, "attachments");
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  const normalizedDir = join(dataDir, "normalized");
  mkdirSync(attachmentsRoot, { recursive: true });
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });
  mkdirSync(normalizedDir, { recursive: true });

  const pdfPath = join(attachmentsRoot, "paper.pdf");
  const bibliographyPath = join(root, "bibliography.json");
  const docKey = sha1("paper.pdf");
  const normalizedPath = join(normalizedDir, `${docKey}.md`);
  const manifestPath = join(manifestsDir, `${docKey}${MANIFEST_EXT}`);

  writeFileSync(pdfPath, "pdf-v1");
  const initialStat = statSync(pdfPath);
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
  writeFileSync(normalizedPath, "Body", "utf-8");
  writeManifestFile(
    manifestPath,
    {
      docKey,
      itemKey: "ITEM1",
      title: "Paper",
      authors: ["A Author"],
      filePath: pdfPath,
      normalizedPath,
      blocks: [trivialBlock()],
    },
  );
  writeCatalogFile(join(indexDir, "catalog.json"), {
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
        size: initialStat.size,
        mtimeMs: Math.trunc(initialStat.mtimeMs),
        sourceHash: "existinghash",
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
    getStatus: async () => ({ totalDocuments: 0, needsEmbedding: 0, hasVectorIndex: false, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });

  unlinkSync(pdfPath);
  const missingResult = await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
    undefined,
    async () => new Map(),
    () => {},
  );

  assert.equal(missingResult.stats.missingAttachments, 1);
  assert.equal(existsSync(normalizedPath), true);
  assert.equal(existsSync(manifestPath), true);

  writeFileSync(pdfPath, "pdf-v1");
  let extractCalls = 0;
  const resumedResult = await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
    undefined,
    async () => {
      extractCalls += 1;
      return new Map();
    },
    () => {},
  );

  assert.equal(extractCalls, 0);
  assert.equal(resumedResult.stats.skippedAttachments, 1);
  assert.equal(resumedResult.stats.updatedAttachments, 0);
  assert.equal(resumedResult.stats.readyAttachments, 1);
});

test("runSync skips unchanged previous extraction errors by default", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-error-cache-"));
  const attachmentsRoot = join(root, "attachments");
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  mkdirSync(attachmentsRoot, { recursive: true });
  mkdirSync(indexDir, { recursive: true });

  const pdfPath = join(attachmentsRoot, "book.pdf");
  writeFileSync(pdfPath, "book");
  const currentStat = statSync(pdfPath);
  const docKey = sha1("book.pdf");
  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "book-cite",
        title: "Large Book",
        author: [{ family: "Book", given: "Author" }],
        file: pdfPath,
        "zotero-item-key": "BOOK",
      },
    ]),
    "utf-8",
  );

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [
      {
        docKey,
        itemKey: "BOOK",
        citationKey: "book-cite",
        title: "Large Book",
        authors: ["Book Author"],
        filePath: pdfPath,
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "error",
        size: currentStat.size,
        mtimeMs: Math.trunc(currentStat.mtimeMs),
        sourceHash: null,
        lastIndexedAt: null,
        error: "Extraction failed for book.pdf: timed out after 180000ms.",
      },
    ],
  });

  const fakeFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ totalDocuments: 0, needsEmbedding: 0, hasVectorIndex: false, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });
  let extractCalls = 0;
  let javaChecks = 0;

  const result = await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
    undefined,
    async () => {
      extractCalls += 1;
      return new Map();
    },
    () => {
      javaChecks += 1;
    },
  );

  assert.equal(extractCalls, 0);
  assert.equal(javaChecks, 0);
  assert.equal(result.stats.errorAttachments, 1);
  assert.equal(result.stats.skippedAttachments, 1);

  const catalog = readCatalogFile(join(indexDir, "catalog.json"));
  assert.equal(catalog.entries[0]?.extractStatus, "error");
  assert.equal(catalog.entries[0]?.error, "Extraction failed for book.pdf: timed out after 180000ms.");

  const logBody = readFileSync(result.logPath, "utf-8");
  assert.match(logBody, /book\.pdf: skipped unchanged previous extraction error/);
});

test("runSync retries unchanged previous errors when requested and passes custom PDF timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-retry-errors-"));
  const attachmentsRoot = join(root, "attachments");
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  const normalizedDir = join(dataDir, "normalized");
  mkdirSync(attachmentsRoot, { recursive: true });
  mkdirSync(indexDir, { recursive: true });

  const pdfPath = join(attachmentsRoot, "book.pdf");
  writeFileSync(pdfPath, "book");
  const currentStat = statSync(pdfPath);
  const docKey = sha1("book.pdf");
  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "book-cite",
        title: "Large Book",
        author: [{ family: "Book", given: "Author" }],
        file: pdfPath,
        "zotero-item-key": "BOOK",
      },
    ]),
    "utf-8",
  );

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [
      {
        docKey,
        itemKey: "BOOK",
        citationKey: "book-cite",
        title: "Large Book",
        authors: ["Book Author"],
        filePath: pdfPath,
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "error",
        size: currentStat.size,
        mtimeMs: Math.trunc(currentStat.mtimeMs),
        sourceHash: null,
        lastIndexedAt: null,
        error: "Extraction failed for book.pdf: timed out after 180000ms.",
      },
    ],
  });

  const fakeFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });
  let extractCalls = 0;
  let seenTimeoutMs: number | undefined;
  const fakeExtractBatch = async (
    batch: Array<{ docKey: string; filePath: string; itemKey: string }>,
    _tempRoot: string,
    manifestsRoot: string,
    normalizedRoot: string,
    options?: { timeoutMs?: number },
  ) => {
    extractCalls += 1;
    seenTimeoutMs = options?.timeoutMs;
    const attachment = batch[0]!;
    const normalizedPath = join(normalizedRoot, `${attachment.docKey}.md`);
    const manifestPath = join(manifestsRoot, `${attachment.docKey}${MANIFEST_EXT}`);
    mkdirSync(normalizedRoot, { recursive: true });
    mkdirSync(manifestsRoot, { recursive: true });
    writeFileSync(normalizedPath, "# Large Book", "utf-8");
    writeManifestFile(
      manifestPath,
      {
        docKey: attachment.docKey,
        itemKey: attachment.itemKey,
        title: "Large Book",
        authors: ["Book Author"],
        filePath: attachment.filePath,
        normalizedPath,
        blocks: [],
      },
    );
    return new Map([[attachment.docKey, { normalizedPath, manifestPath }]]);
  };

  const result = await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
    undefined,
    fakeExtractBatch,
    () => {},
    { retryErrors: true, pdfTimeoutMs: 1_800_000 },
  );

  assert.equal(extractCalls, 1);
  assert.equal(seenTimeoutMs, 1_800_000);
  assert.equal(result.stats.readyAttachments, 1);
  assert.equal(result.stats.updatedAttachments, 1);
  assert.equal(result.stats.errorAttachments, 0);
});

test("runSync extracts book attachments in single-file batches by default", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-book-batches-"));
  const attachmentsRoot = join(root, "attachments");
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  const normalizedDir = join(dataDir, "normalized");
  mkdirSync(join(attachmentsRoot, "Book"), { recursive: true });
  mkdirSync(join(attachmentsRoot, "papers"), { recursive: true });

  const bookPath = join(attachmentsRoot, "Book", "book.pdf");
  const paperOnePath = join(attachmentsRoot, "papers", "paper-one.pdf");
  const paperTwoPath = join(attachmentsRoot, "papers", "paper-two.pdf");
  writeFileSync(bookPath, "book");
  writeFileSync(paperOnePath, "paper one");
  writeFileSync(paperTwoPath, "paper two");

  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "book-cite",
        title: "Large Book",
        type: "book",
        file: bookPath,
        "zotero-item-key": "BOOK",
      },
      {
        id: "paper-one-cite",
        title: "Paper One",
        type: "article-journal",
        file: paperOnePath,
        "zotero-item-key": "PAPER1",
      },
      {
        id: "paper-two-cite",
        title: "Paper Two",
        type: "article-journal",
        file: paperTwoPath,
        "zotero-item-key": "PAPER2",
      },
    ]),
    "utf-8",
  );

  const fakeFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ totalDocuments: 3, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });
  const batches: string[][] = [];
  const fakeExtractBatch = async (batch: Array<{ docKey: string; filePath: string; itemKey: string }>) => {
    batches.push(batch.map((attachment) => attachment.itemKey));
    const out = new Map<string, { manifestPath: string; normalizedPath: string }>();

    for (const attachment of batch) {
      const normalizedPath = join(normalizedDir, `${attachment.docKey}.md`);
      const manifestPath = join(manifestsDir, `${attachment.docKey}${MANIFEST_EXT}`);
      mkdirSync(normalizedDir, { recursive: true });
      mkdirSync(manifestsDir, { recursive: true });
      writeFileSync(normalizedPath, `# ${attachment.itemKey}`, "utf-8");
      writeManifestFile(
        manifestPath,
        {
          docKey: attachment.docKey,
          itemKey: attachment.itemKey,
          title: attachment.itemKey,
          authors: [],
          filePath: attachment.filePath,
          normalizedPath,
          blocks: [],
        },
      );
      out.set(attachment.docKey, { normalizedPath, manifestPath });
    }

    return out;
  };

  const result = await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
    undefined,
    fakeExtractBatch,
    () => {},
  );

  assert.equal(result.stats.readyAttachments, 3);
  assert.equal(batches.some((batch) => batch.length > 1 && batch.includes("BOOK")), false);
  assert.deepEqual(batches.find((batch) => batch.includes("BOOK")), ["BOOK"]);
  assert.equal(batches.some((batch) => batch.includes("PAPER1") && batch.includes("PAPER2")), true);
});

test("runSync honors explicit PDF batch size", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-batch-size-"));
  const attachmentsRoot = join(root, "attachments");
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  const normalizedDir = join(dataDir, "normalized");
  mkdirSync(attachmentsRoot, { recursive: true });

  const onePath = join(attachmentsRoot, "one.pdf");
  const twoPath = join(attachmentsRoot, "two.pdf");
  writeFileSync(onePath, "one");
  writeFileSync(twoPath, "two");

  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "one-cite",
        title: "One",
        type: "article-journal",
        file: onePath,
        "zotero-item-key": "ONE",
      },
      {
        id: "two-cite",
        title: "Two",
        type: "article-journal",
        file: twoPath,
        "zotero-item-key": "TWO",
      },
    ]),
    "utf-8",
  );

  const fakeFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ totalDocuments: 2, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });
  const batchSizes: number[] = [];
  const fakeExtractBatch = async (batch: Array<{ docKey: string; filePath: string; itemKey: string }>) => {
    batchSizes.push(batch.length);
    const out = new Map<string, { manifestPath: string; normalizedPath: string }>();

    for (const attachment of batch) {
      const normalizedPath = join(normalizedDir, `${attachment.docKey}.md`);
      const manifestPath = join(manifestsDir, `${attachment.docKey}${MANIFEST_EXT}`);
      mkdirSync(normalizedDir, { recursive: true });
      mkdirSync(manifestsDir, { recursive: true });
      writeFileSync(normalizedPath, `# ${attachment.itemKey}`, "utf-8");
      writeManifestFile(
        manifestPath,
        {
          docKey: attachment.docKey,
          itemKey: attachment.itemKey,
          title: attachment.itemKey,
          authors: [],
          filePath: attachment.filePath,
          normalizedPath,
          blocks: [],
        },
      );
      out.set(attachment.docKey, { normalizedPath, manifestPath });
    }

    return out;
  };

  const result = await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
    undefined,
    fakeExtractBatch,
    () => {},
    { pdfBatchSize: 1 },
  );

  assert.equal(result.stats.readyAttachments, 2);
  assert.deepEqual(batchSizes, [1, 1]);
});

test("runSync records extraction failures per attachment and continues indexing others", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-error-"));
  const attachmentsRoot = join(root, "attachments");
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  const normalizedDir = join(dataDir, "normalized");
  mkdirSync(attachmentsRoot, { recursive: true });

  const goodPdfPath = join(attachmentsRoot, "good.pdf");
  const badPdfPath = join(attachmentsRoot, "bad.pdf");
  writeFileSync(goodPdfPath, "good");
  writeFileSync(badPdfPath, "bad");

  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "good-cite",
        title: "Good Paper",
        author: [{ family: "Good", given: "Author" }],
        file: goodPdfPath,
        "zotero-item-key": "GOOD",
      },
      {
        id: "bad-cite",
        title: "Bad Paper",
        author: [{ family: "Bad", given: "Author" }],
        file: badPdfPath,
        "zotero-item-key": "BAD",
      },
    ]),
    "utf-8",
  );

  const fakeFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });

  const fakeExtractBatch = async (batch: Array<{ docKey: string; filePath: string; itemKey: string }>) => {
    const out = new Map<string, { manifestPath: string; normalizedPath: string }>();
    for (const attachment of batch) {
      if (attachment.itemKey === "BAD") {
        throw new Error([
          "Apr 02, 2026 8:08:03 PM org.verapdf.pd.font.cmap.CMapParser readLineBFRange",
          "WARNING: Incorrect bfrange in toUnicode CMap: the last byte of the string incremented past 255.",
          "java.lang.IllegalStateException: malformed PDF xref table",
        ].join("\n"));
      }

      const normalizedPath = join(normalizedDir, `${attachment.docKey}.md`);
      const manifestPath = join(manifestsDir, `${attachment.docKey}${MANIFEST_EXT}`);
      mkdirSync(normalizedDir, { recursive: true });
      mkdirSync(manifestsDir, { recursive: true });
      writeFileSync(normalizedPath, "# Good Paper", "utf-8");
      writeManifestFile(
        manifestPath,
        {
          docKey: attachment.docKey,
          itemKey: attachment.itemKey,
          title: "Good Paper",
          authors: ["Good Author"],
          filePath: attachment.filePath,
          normalizedPath,
          blocks: [],
        },
      );
      out.set(attachment.docKey, { normalizedPath, manifestPath });
    }
    return out;
  };

  const result = await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
    undefined,
    fakeExtractBatch,
    () => {},
  );

  assert.equal(result.stats.readyAttachments, 1);
  assert.equal(result.stats.errorAttachments, 1);
  assert.equal(result.stats.indexedAttachments, 1);
  assert.equal(result.stats.updatedAttachments, 1);
  assert.equal(existsSync(result.logPath), true);

  const catalog = readCatalogFile(join(dataDir, "index", "catalog.json"));
  const goodEntry = catalog.entries.find((entry) => entry.itemKey === "GOOD");
  const badEntry = catalog.entries.find((entry) => entry.itemKey === "BAD");
  assert.equal(goodEntry?.extractStatus, "ready");
  assert.equal(badEntry?.extractStatus, "error");
  assert.match(badEntry?.error || "", /Extraction failed/);
  assert.match(badEntry?.error || "", /bad\.pdf/);
  assert.match(badEntry?.error || "", /malformed PDF xref table/);

  const logBody = readFileSync(result.logPath, "utf-8");
  const latestLogPath = join(dataDir, "logs", "sync-latest.log");
  assert.equal(existsSync(latestLogPath), true);
  assert.match(logBody, /# zotagent sync log/);
  assert.match(logBody, /Loaded bibliography with 2 records and 2 attachments/);
  assert.match(logBody, /## Errored Files/);
  assert.match(logBody, /Extraction failed for .*bad\.pdf/);
  assert.match(logBody, /bad\.pdf: java\.lang\.IllegalStateException: malformed PDF xref table/);
  assert.match(logBody, /malformed PDF xref table/);
});

test("runSync retries a timed out batch one file at a time", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotagent-sync-timeout-"));
  const attachmentsRoot = join(root, "attachments");
  const dataDir = join(root, "data");
  const manifestsDir = join(dataDir, "manifests");
  const normalizedDir = join(dataDir, "normalized");
  mkdirSync(attachmentsRoot, { recursive: true });

  const goodPdfPath = join(attachmentsRoot, "good.pdf");
  const badPdfPath = join(attachmentsRoot, "bad.pdf");
  writeFileSync(goodPdfPath, "good");
  writeFileSync(badPdfPath, "bad");

  const bibliographyPath = join(root, "bibliography.json");
  writeFileSync(
    bibliographyPath,
    JSON.stringify([
      {
        id: "good-cite",
        title: "Good Paper",
        author: [{ family: "Good", given: "Author" }],
        file: goodPdfPath,
        "zotero-item-key": "GOOD",
      },
      {
        id: "bad-cite",
        title: "Bad Paper",
        author: [{ family: "Bad", given: "Author" }],
        file: badPdfPath,
        "zotero-item-key": "BAD",
      },
    ]),
    "utf-8",
  );

  const fakeFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    clearEmbeddings: async () => {},
    cleanupOrphans: async () => ({ deletedInactiveDocuments: 0, cleanedOrphanedContent: 0, cleanedOrphanedVectors: 0 }),
    close: async () => {},
  });

  let batchCalls = 0;
  const fakeExtractBatch = async (batch: Array<{ docKey: string; filePath: string; itemKey: string }>) => {
    batchCalls += 1;
    if (batch.length > 1) {
      throw new Error("OpenDataLoader PDF extraction timed out after 180000ms.");
    }

    const attachment = batch[0]!;
    if (attachment.itemKey === "BAD") {
      throw new Error("OpenDataLoader PDF extraction timed out after 180000ms.");
    }

    const normalizedPath = join(normalizedDir, `${attachment.docKey}.md`);
    const manifestPath = join(manifestsDir, `${attachment.docKey}${MANIFEST_EXT}`);
    mkdirSync(normalizedDir, { recursive: true });
    mkdirSync(manifestsDir, { recursive: true });
    writeFileSync(normalizedPath, "# Good Paper", "utf-8");
    writeManifestFile(
      manifestPath,
      {
        docKey: attachment.docKey,
        itemKey: attachment.itemKey,
        title: "Good Paper",
        authors: ["Good Author"],
        filePath: attachment.filePath,
        normalizedPath,
        blocks: [],
      },
    );

    return new Map([[attachment.docKey, { normalizedPath, manifestPath }]]);
  };

  const result = await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
    undefined,
    fakeExtractBatch,
    () => {},
  );

  assert.equal(batchCalls, 3);
  assert.equal(result.stats.readyAttachments, 1);
  assert.equal(result.stats.errorAttachments, 1);

  const catalog = readCatalogFile(join(dataDir, "index", "catalog.json"));
  const goodEntry = catalog.entries.find((entry) => entry.itemKey === "GOOD");
  const badEntry = catalog.entries.find((entry) => entry.itemKey === "BAD");
  assert.equal(goodEntry?.extractStatus, "ready");
  assert.equal(badEntry?.extractStatus, "error");
  assert.match(badEntry?.error || "", /timed out after 180000ms/);
});
