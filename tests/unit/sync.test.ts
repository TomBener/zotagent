import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildHiddenJavaToolOptions,
  runProcessWithTimeout,
  runSync,
  withHiddenJavaDockIcon,
} from "../../src/sync.js";
import { readCatalogFile, writeCatalogFile } from "../../src/state.js";
import type { CatalogFile } from "../../src/types.js";
import { sha1 } from "../../src/utils.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const syncModuleUrl = new URL("../../src/sync.ts", import.meta.url).href;

function runInlineModule(script: string, timeout = 5_000) {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout,
  });
}

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

      const root = mkdtempSync(join(tmpdir(), "zotlit-sync-signal-"));
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
        close: async () => {},
      });
      const fakeExactFactory = async () => ({
        rebuildExactIndex: async () => {},
        searchExactCandidates: async () => [],
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
        fakeExactFactory,
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

      const root = mkdtempSync(join(tmpdir(), "zotlit-sync-uncaught-"));
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
        close: async () => {},
      });
      const fakeExactFactory = async () => ({
        rebuildExactIndex: async () => {},
        searchExactCandidates: async () => [],
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
        fakeExactFactory,
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
  const docKey = sha1("papers/paper.pdf");
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
    exactRebuild: 0,
    exactClose: 0,
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
    close: async () => {
      calls.closed += 1;
    },
  });
  const fakeExactFactory = async () => ({
    rebuildExactIndex: async () => {
      calls.exactRebuild += 1;
    },
    searchExactCandidates: async () => [],
    close: async () => {
      calls.exactClose += 1;
    },
  });

  const result = await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
    fakeExactFactory,
  );

  assert.equal(result.stats.skippedAttachments, 1);
  assert.equal(result.stats.updatedAttachments, 0);
  assert.equal(calls.exactRebuild, 1);
  assert.equal(calls.exactClose, 1);
  assert.equal(calls.update, 1);
  assert.equal(calls.embed, 1);
  assert.equal(calls.removed, 1);
  assert.equal(calls.added, 1);
  assert.equal(calls.closed, 1);

  const logBody = readFileSync(result.logPath, "utf-8");
  assert.match(logBody, /## Skipped Files/);
  assert.match(logBody, /paper\.pdf: reused existing indexed output/);
});

test("runSync sends exact-index deltas when incremental sync is available", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-sync-exact-delta-"));
  const attachmentsRoot = join(root, "attachments");
  const dataDir = join(root, "data");
  const indexDir = join(dataDir, "index");
  const manifestsDir = join(dataDir, "manifests");
  const normalizedDir = join(dataDir, "normalized");
  mkdirSync(join(attachmentsRoot, "papers"), { recursive: true });
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });
  mkdirSync(normalizedDir, { recursive: true });

  const oldPdfPath = join(attachmentsRoot, "papers", "old.pdf");
  const newPdfPath = join(attachmentsRoot, "papers", "new.pdf");
  writeFileSync(oldPdfPath, "old-pdf");
  writeFileSync(newPdfPath, "new-pdf");

  const oldDocKey = sha1("papers/old.pdf");
  const newDocKey = sha1("papers/new.pdf");
  const oldManifestPath = join(manifestsDir, `${oldDocKey}.json`);
  const oldNormalizedPath = join(normalizedDir, `${oldDocKey}.md`);
  writeFileSync(oldNormalizedPath, "old body", "utf-8");
  writeFileSync(
    oldManifestPath,
    JSON.stringify({
      docKey: oldDocKey,
      itemKey: "OLD1",
      title: "Old Paper",
      authors: ["A Author"],
      filePath: oldPdfPath,
      normalizedPath: oldNormalizedPath,
      blocks: [],
    }),
    "utf-8",
  );

  writeCatalogFile(join(indexDir, "catalog.json"), {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [
      {
        docKey: oldDocKey,
        itemKey: "OLD1",
        citationKey: "oldcite",
        title: "Old Paper",
        authors: ["A Author"],
        filePath: oldPdfPath,
        fileExt: "pdf",
        exists: true,
        supported: true,
        extractStatus: "ready",
        size: statSync(oldPdfPath).size,
        mtimeMs: Math.trunc(statSync(oldPdfPath).mtimeMs),
        sourceHash: "oldhash",
        lastIndexedAt: new Date().toISOString(),
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
        id: "newcite",
        title: "New Paper",
        author: [{ family: "B", given: "Author" }],
        file: newPdfPath,
        "zotero-item-key": "NEW1",
      },
    ]),
    "utf-8",
  );

  let captured:
    | {
        readyDocKeys: string[];
        upsertDocKeys: string[];
        deleteDocKeys: string[];
      }
    | undefined;
  let rebuildCalls = 0;

  const fakeFactory = async () => ({
    search: async () => [],
    searchLex: async () => [],
    update: async () => ({}),
    embed: async () => ({}),
    getStatus: async () => ({ totalDocuments: 1, needsEmbedding: 0, hasVectorIndex: true, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    close: async () => {},
  });
  const fakeExactFactory = async () => ({
    rebuildExactIndex: async () => {
      rebuildCalls += 1;
    },
    syncExactIndex: async (
      readyEntries: Array<{ docKey: string }>,
      changes: { upserts: Array<{ docKey: string }>; deleteDocKeys: string[] },
    ) => {
      captured = {
        readyDocKeys: readyEntries.map((entry) => entry.docKey),
        upsertDocKeys: changes.upserts.map((entry) => entry.docKey),
        deleteDocKeys: changes.deleteDocKeys,
      };
    },
    searchExactCandidates: async () => [],
    close: async () => {},
  });
  const fakeExtractBatch = async (batch: Array<{ docKey: string; filePath: string; itemKey: string }>) => {
    const out = new Map<string, { manifestPath: string; normalizedPath: string }>();
    for (const attachment of batch) {
      const normalizedPath = join(normalizedDir, `${attachment.docKey}.md`);
      const manifestPath = join(manifestsDir, `${attachment.docKey}.json`);
      writeFileSync(normalizedPath, "new body", "utf-8");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          docKey: attachment.docKey,
          itemKey: attachment.itemKey,
          title: "New Paper",
          authors: ["B Author"],
          filePath: attachment.filePath,
          normalizedPath,
          blocks: [],
        }),
        "utf-8",
      );
      out.set(attachment.docKey, { manifestPath, normalizedPath });
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
    fakeExactFactory,
    fakeExtractBatch,
  );

  assert.equal(result.stats.readyAttachments, 1);
  assert.equal(rebuildCalls, 0);
  assert.deepEqual(captured, {
    readyDocKeys: [newDocKey],
    upsertDocKeys: [newDocKey],
    deleteDocKeys: [oldDocKey],
  });
});

test("runSync resumes from existing normalized and manifest outputs when catalog state is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-sync-resume-"));
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
  const manifestPath = join(manifestsDir, `${docKey}.json`);
  writeFileSync(normalizedPath, "Body", "utf-8");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      docKey,
      itemKey: "ITEM1",
      title: "Paper",
      authors: ["A Author"],
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
    close: async () => {},
  });
  const fakeExactFactory = async () => ({
    rebuildExactIndex: async () => {},
    searchExactCandidates: async () => [],
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
    fakeExactFactory,
    fakeExtractBatch,
  );

  assert.equal(extractCalls, 0);
  assert.equal(result.stats.skippedAttachments, 1);
  assert.equal(result.stats.updatedAttachments, 0);
  assert.equal(result.stats.readyAttachments, 1);

  const nextCatalog = readCatalogFile(join(indexDir, "catalog.json"));
  assert.equal(nextCatalog.entries[0]?.extractStatus, "ready");
  assert.equal(nextCatalog.entries[0]?.normalizedPath, normalizedPath);
  assert.equal(nextCatalog.entries[0]?.manifestPath, manifestPath);
});

test("runSync re-extracts attachments when fallback normalized output is empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-sync-empty-fallback-"));
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
  const manifestPath = join(manifestsDir, `${docKey}.json`);
  writeFileSync(normalizedPath, "", "utf-8");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      docKey,
      itemKey: "ITEM1",
      title: "Paper",
      authors: ["A Author"],
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
    close: async () => {},
  });
  const fakeExactFactory = async () => ({
    rebuildExactIndex: async () => {},
    searchExactCandidates: async () => [],
    close: async () => {},
  });
  const fakeExtractBatch = async (batch: Array<{ docKey: string; filePath: string; itemKey: string }>) => {
    extractCalls += 1;
    const attachment = batch[0]!;
    writeFileSync(normalizedPath, "Recovered body", "utf-8");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        docKey: attachment.docKey,
        itemKey: attachment.itemKey,
        title: "Paper",
        authors: ["A Author"],
        filePath: attachment.filePath,
        normalizedPath,
        blocks: [],
      }),
      "utf-8",
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
    fakeExactFactory,
    fakeExtractBatch,
  );

  assert.equal(extractCalls, 1);
  assert.equal(result.stats.readyAttachments, 1);
  assert.equal(result.stats.updatedAttachments, 1);
  assert.equal(result.stats.skippedAttachments, 0);
  assert.equal(readFileSync(normalizedPath, "utf-8"), "Recovered body");
});

test("runSync keeps embedding until qmd no longer reports pending documents", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-sync-embed-loop-"));
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
  const manifestPath = join(manifestsDir, `${docKey}.json`);
  writeFileSync(normalizedPath, "Body", "utf-8");
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
    close: async () => {},
  });
  const fakeExactFactory = async () => ({
    rebuildExactIndex: async () => {},
    searchExactCandidates: async () => [],
    close: async () => {},
  });

  await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
    fakeExactFactory,
  );

  assert.equal(embedCalls, 3);
  assert.equal(needsEmbedding, 0);
});

test("runSync marks empty txt extraction output as error", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-sync-empty-txt-"));
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
    close: async () => {},
  });
  const fakeExactFactory = async () => ({
    rebuildExactIndex: async () => {},
    searchExactCandidates: async () => [],
    close: async () => {},
  });

  const result = await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
    fakeExactFactory,
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
  const root = mkdtempSync(join(tmpdir(), "zotlit-sync-txt-"));
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
    close: async () => {},
  });
  const fakeExactFactory = async () => ({
    rebuildExactIndex: async () => {},
    searchExactCandidates: async () => [],
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
    fakeExactFactory,
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
  assert.match(readFileSync(manifestPath!, "utf-8"), /第二段/);
});

test("runSync reuses a ready index when bibliography paths come from another machine", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-sync-relocate-"));
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
  const manifestPath = join(manifestsDir, `${docKey}.json`);
  writeFileSync(normalizedPath, "Body");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      docKey,
      itemKey: "ITEM1",
      title: "Paper",
      authors: ["A"],
      filePath: foreignPath,
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
    close: async () => {},
  });
  const fakeExactFactory = async () => ({
    rebuildExactIndex: async () => {},
    searchExactCandidates: async () => [],
    close: async () => {},
  });

  const result = await runSync(
    {
      bibliographyJsonPath: bibliographyPath,
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
    fakeExactFactory,
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
  const root = mkdtempSync(join(homedir(), ".zotlit-catalog-home-"));
  try {
    const dataDir = join(root, "Zotlit");
    const indexDir = join(dataDir, "index");
    const normalizedDir = join(dataDir, "normalized");
    const manifestsDir = join(dataDir, "manifests");
    mkdirSync(indexDir, { recursive: true });
    mkdirSync(normalizedDir, { recursive: true });
    mkdirSync(manifestsDir, { recursive: true });

    const docKey = "7".repeat(40);
    const pdfPath = join(root, "Zotero", "paper.pdf");
    const normalizedPath = join(normalizedDir, `${docKey}.md`);
    const manifestPath = join(manifestsDir, `${docKey}.json`);
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
  const root = mkdtempSync(join(homedir(), ".zotlit-catalog-relocate-"));
  try {
    const dataDir = join(root, "Library", "Mobile Documents", "com~apple~CloudDocs", "Zotlit");
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
    const manifestPath = join(manifestsDir, `${docKey}.json`);
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

test("runSync keeps cached outputs when attachment disappears from the current catalog", async () => {
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
    getStatus: async () => ({ totalDocuments: 0, needsEmbedding: 0, hasVectorIndex: false, collections: [] }),
    listContexts: async () => [],
    addContext: async () => true,
    removeContext: async () => true,
    close: async () => {},
  });
  const fakeExactFactory = async () => ({
    rebuildExactIndex: async () => {},
    searchExactCandidates: async () => [],
    close: async () => {},
  });

  const result = await runSync(
    {
      bibliographyJsonPath: join(root, "bibliography.json"),
      attachmentsRoot,
      dataDir,
    },
    fakeFactory,
    fakeExactFactory,
  );

  assert.equal(result.stats.removedAttachments, 1);
  assert.equal(statSync(indexDir).isDirectory(), true);
  assert.equal(existsSync(normalizedPath), true);
  assert.equal(existsSync(manifestPath), true);
});

test("runSync reuses cached outputs after an attachment temporarily disappears", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-sync-resume-missing-"));
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
  const manifestPath = join(manifestsDir, `${docKey}.json`);

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
  writeFileSync(
    manifestPath,
    JSON.stringify({
      docKey,
      itemKey: "ITEM1",
      title: "Paper",
      authors: ["A Author"],
      filePath: pdfPath,
      normalizedPath,
      blocks: [],
    }),
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
    close: async () => {},
  });
  const fakeExactFactory = async () => ({
    rebuildExactIndex: async () => {},
    searchExactCandidates: async () => [],
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
    fakeExactFactory,
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
    fakeExactFactory,
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
  const root = mkdtempSync(join(tmpdir(), "zotlit-sync-error-cache-"));
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
    close: async () => {},
  });
  const fakeExactFactory = async () => ({
    rebuildExactIndex: async () => {},
    searchExactCandidates: async () => [],
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
    fakeExactFactory,
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
  const root = mkdtempSync(join(tmpdir(), "zotlit-sync-retry-errors-"));
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
    close: async () => {},
  });
  const fakeExactFactory = async () => ({
    rebuildExactIndex: async () => {},
    searchExactCandidates: async () => [],
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
    const manifestPath = join(manifestsRoot, `${attachment.docKey}.json`);
    mkdirSync(normalizedRoot, { recursive: true });
    mkdirSync(manifestsRoot, { recursive: true });
    writeFileSync(normalizedPath, "# Large Book", "utf-8");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        docKey: attachment.docKey,
        itemKey: attachment.itemKey,
        title: "Large Book",
        authors: ["Book Author"],
        filePath: attachment.filePath,
        normalizedPath,
        blocks: [],
      }),
      "utf-8",
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
    fakeExactFactory,
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
  const root = mkdtempSync(join(tmpdir(), "zotlit-sync-book-batches-"));
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
    close: async () => {},
  });
  const fakeExactFactory = async () => ({
    rebuildExactIndex: async () => {},
    searchExactCandidates: async () => [],
    close: async () => {},
  });
  const batches: string[][] = [];
  const fakeExtractBatch = async (batch: Array<{ docKey: string; filePath: string; itemKey: string }>) => {
    batches.push(batch.map((attachment) => attachment.itemKey));
    const out = new Map<string, { manifestPath: string; normalizedPath: string }>();

    for (const attachment of batch) {
      const normalizedPath = join(normalizedDir, `${attachment.docKey}.md`);
      const manifestPath = join(manifestsDir, `${attachment.docKey}.json`);
      mkdirSync(normalizedDir, { recursive: true });
      mkdirSync(manifestsDir, { recursive: true });
      writeFileSync(normalizedPath, `# ${attachment.itemKey}`, "utf-8");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          docKey: attachment.docKey,
          itemKey: attachment.itemKey,
          title: attachment.itemKey,
          authors: [],
          filePath: attachment.filePath,
          normalizedPath,
          blocks: [],
        }),
        "utf-8",
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
    fakeExactFactory,
    fakeExtractBatch,
    () => {},
  );

  assert.equal(result.stats.readyAttachments, 3);
  assert.equal(batches.some((batch) => batch.length > 1 && batch.includes("BOOK")), false);
  assert.deepEqual(batches.find((batch) => batch.includes("BOOK")), ["BOOK"]);
  assert.equal(batches.some((batch) => batch.includes("PAPER1") && batch.includes("PAPER2")), true);
});

test("runSync honors explicit PDF batch size", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-sync-batch-size-"));
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
    close: async () => {},
  });
  const fakeExactFactory = async () => ({
    rebuildExactIndex: async () => {},
    searchExactCandidates: async () => [],
    close: async () => {},
  });
  const batchSizes: number[] = [];
  const fakeExtractBatch = async (batch: Array<{ docKey: string; filePath: string; itemKey: string }>) => {
    batchSizes.push(batch.length);
    const out = new Map<string, { manifestPath: string; normalizedPath: string }>();

    for (const attachment of batch) {
      const normalizedPath = join(normalizedDir, `${attachment.docKey}.md`);
      const manifestPath = join(manifestsDir, `${attachment.docKey}.json`);
      mkdirSync(normalizedDir, { recursive: true });
      mkdirSync(manifestsDir, { recursive: true });
      writeFileSync(normalizedPath, `# ${attachment.itemKey}`, "utf-8");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          docKey: attachment.docKey,
          itemKey: attachment.itemKey,
          title: attachment.itemKey,
          authors: [],
          filePath: attachment.filePath,
          normalizedPath,
          blocks: [],
        }),
        "utf-8",
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
    fakeExactFactory,
    fakeExtractBatch,
    () => {},
    { pdfBatchSize: 1 },
  );

  assert.equal(result.stats.readyAttachments, 2);
  assert.deepEqual(batchSizes, [1, 1]);
});

test("runSync records extraction failures per attachment and continues indexing others", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-sync-error-"));
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
    close: async () => {},
  });
  const fakeExactFactory = async () => ({
    rebuildExactIndex: async () => {},
    searchExactCandidates: async () => [],
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
      const manifestPath = join(manifestsDir, `${attachment.docKey}.json`);
      mkdirSync(normalizedDir, { recursive: true });
      mkdirSync(manifestsDir, { recursive: true });
      writeFileSync(normalizedPath, "# Good Paper", "utf-8");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          docKey: attachment.docKey,
          itemKey: attachment.itemKey,
          title: "Good Paper",
          authors: ["Good Author"],
          filePath: attachment.filePath,
          normalizedPath,
          blocks: [],
        }),
        "utf-8",
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
    fakeExactFactory,
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
  assert.match(logBody, /# zotlit sync log/);
  assert.match(logBody, /Loaded bibliography with 2 records and 2 attachments/);
  assert.match(logBody, /## Errored Files/);
  assert.match(logBody, /Extraction failed for .*bad\.pdf/);
  assert.match(logBody, /bad\.pdf: java\.lang\.IllegalStateException: malformed PDF xref table/);
  assert.match(logBody, /malformed PDF xref table/);
});

test("runSync retries a timed out batch one file at a time", async () => {
  const root = mkdtempSync(join(tmpdir(), "zotlit-sync-timeout-"));
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
    close: async () => {},
  });
  const fakeExactFactory = async () => ({
    rebuildExactIndex: async () => {},
    searchExactCandidates: async () => [],
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
    const manifestPath = join(manifestsDir, `${attachment.docKey}.json`);
    mkdirSync(normalizedDir, { recursive: true });
    mkdirSync(manifestsDir, { recursive: true });
    writeFileSync(normalizedPath, "# Good Paper", "utf-8");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        docKey: attachment.docKey,
        itemKey: attachment.itemKey,
        title: "Good Paper",
        authors: ["Good Author"],
        filePath: attachment.filePath,
        normalizedPath,
        blocks: [],
      }),
      "utf-8",
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
    fakeExactFactory,
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
