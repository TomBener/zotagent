import { convert } from "@opendataloader/pdf";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { loadCatalog } from "./catalog.js";
import { getDataPaths, resolveConfig, type ConfigOverrides } from "./config.js";
import { buildPdfManifest } from "./manifest.js";
import { openQmdClient, type QmdFactory } from "./qmd.js";
import { mapEntriesByDocKey, readCatalogFile, summarizeCatalog, writeCatalogFile } from "./state.js";
import { openExactIndex, type ExactIndexFactory } from "./tantivy.js";
import type { AttachmentCatalogEntry, CatalogEntry, CatalogFile, SyncStats } from "./types.js";
import {
  chunkArray,
  ensureDir,
  ensureParentDir,
  exists,
  stemForFile,
} from "./utils.js";

const HIDE_JAVA_DOCK_ICON_FLAG = "-Dapple.awt.UIElement=true";

function logSyncPhase(message: string): void {
  if (process.stderr.isTTY) {
    process.stderr.write(`${message}\n`);
  }
}

async function sha1File(filePath: string): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const hash = createHash("sha1");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function requireJava(): void {
  const javaCheck = spawnSync("java", ["-version"], { encoding: "utf-8" });
  if (javaCheck.error || javaCheck.status !== 0) {
    throw new Error(
      "Java runtime is required for PDF extraction. Install JDK 11+ and make sure `java -version` works.",
    );
  }
}

function shouldHideJavaDockIcon(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return platform === "darwin" && env.ZOTLIT_SHOW_JAVA_DOCK_ICON !== "1";
}

export function buildHiddenJavaToolOptions(existing: string | undefined): string {
  if (!existing || existing.trim().length === 0) {
    return HIDE_JAVA_DOCK_ICON_FLAG;
  }
  if (existing.includes(HIDE_JAVA_DOCK_ICON_FLAG)) {
    return existing;
  }
  return `${existing} ${HIDE_JAVA_DOCK_ICON_FLAG}`;
}

export async function withHiddenJavaDockIcon<T>(
  task: () => Promise<T>,
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<T> {
  const env = options.env ?? process.env;
  if (!shouldHideJavaDockIcon(options.platform, env)) {
    return await task();
  }

  const previous = env.JAVA_TOOL_OPTIONS;
  env.JAVA_TOOL_OPTIONS = buildHiddenJavaToolOptions(previous);

  try {
    return await task();
  } finally {
    if (previous === undefined) {
      delete env.JAVA_TOOL_OPTIONS;
    } else {
      env.JAVA_TOOL_OPTIONS = previous;
    }
  }
}

function toCatalogEntry(
  attachment: AttachmentCatalogEntry,
  partial: Partial<CatalogEntry> & Pick<CatalogEntry, "extractStatus">,
): CatalogEntry {
  return {
    docKey: attachment.docKey,
    itemKey: attachment.itemKey,
    ...(attachment.citationKey ? { citationKey: attachment.citationKey } : {}),
    title: attachment.title,
    authors: attachment.authors,
    ...(attachment.year ? { year: attachment.year } : {}),
    ...(attachment.abstract ? { abstract: attachment.abstract } : {}),
    ...(attachment.type ? { type: attachment.type } : {}),
    filePath: attachment.filePath,
    fileExt: attachment.fileExt,
    exists: attachment.exists,
    supported: attachment.supported,
    size: partial.size ?? null,
    mtimeMs: partial.mtimeMs ?? null,
    sourceHash: partial.sourceHash ?? null,
    lastIndexedAt: partial.lastIndexedAt ?? null,
    extractStatus: partial.extractStatus,
    ...(partial.normalizedPath ? { normalizedPath: partial.normalizedPath } : {}),
    ...(partial.manifestPath ? { manifestPath: partial.manifestPath } : {}),
    ...(partial.error ? { error: partial.error } : {}),
  };
}

function deleteIfExists(path: string | undefined): void {
  if (path && exists(path)) {
    unlinkSync(path);
  }
}

function groupForOdlBatches(attachments: AttachmentCatalogEntry[], maxBatchSize = 8): AttachmentCatalogEntry[][] {
  const out: AttachmentCatalogEntry[][] = [];
  let current: AttachmentCatalogEntry[] = [];
  let stems = new Set<string>();

  for (const attachment of attachments) {
    const stem = stemForFile(attachment.filePath);
    if (current.length >= maxBatchSize || stems.has(stem)) {
      out.push(current);
      current = [];
      stems = new Set<string>();
    }
    current.push(attachment);
    stems.add(stem);
  }

  if (current.length > 0) out.push(current);
  return out;
}

async function extractBatch(
  batch: AttachmentCatalogEntry[],
  tempRoot: string,
  manifestsDir: string,
  normalizedDir: string,
): Promise<Map<string, { manifestPath: string; normalizedPath: string }>> {
  const tempDir = mkdtempSync(join(tempRoot, "odl-"));
  const byDocKey = new Map<string, { manifestPath: string; normalizedPath: string }>();

  try {
    await withHiddenJavaDockIcon(() =>
      convert(
        batch.map((attachment) => attachment.filePath),
        {
          outputDir: tempDir,
          format: "markdown,json",
        },
      ),
    );

    for (const attachment of batch) {
      const stem = stemForFile(attachment.filePath);
      const markdownPath = resolve(tempDir, `${stem}.md`);
      const jsonPath = resolve(tempDir, `${stem}.json`);
      if (!exists(markdownPath) || !exists(jsonPath)) {
        throw new Error(`OpenDataLoader output not found for ${attachment.filePath}`);
      }

      const normalizedPath = resolve(normalizedDir, `${attachment.docKey}.md`);
      const manifestPath = resolve(manifestsDir, `${attachment.docKey}.json`);
      ensureParentDir(normalizedPath);
      ensureParentDir(manifestPath);

      const built = buildPdfManifest(
        attachment,
        readFileSync(markdownPath, "utf-8"),
        readFileSync(jsonPath, "utf-8"),
        normalizedPath,
      );

      writeFileSync(normalizedPath, built.markdown, "utf-8");
      writeFileSync(manifestPath, JSON.stringify(built.manifest, null, 2), "utf-8");
      byDocKey.set(attachment.docKey, { manifestPath, normalizedPath });
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  return byDocKey;
}

function buildContext(entry: CatalogEntry): string {
  const parts = [
    entry.title,
    entry.authors.length > 0 ? entry.authors.join(", ") : undefined,
    entry.year,
    entry.abstract,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return parts.join("\n");
}

async function syncQmdContexts(qmd: Awaited<ReturnType<QmdFactory>>, readyEntries: CatalogEntry[]): Promise<void> {
  const existing = await qmd.listContexts();
  for (const row of existing) {
    if (row.collection === "library") {
      await qmd.removeContext("library", row.path);
    }
  }

  for (const entry of readyEntries) {
    await qmd.addContext("library", `/${entry.docKey}.md`, buildContext(entry));
  }
}

export async function runSync(
  overrides: ConfigOverrides = {},
  qmdFactory: QmdFactory = openQmdClient,
  exactFactory: ExactIndexFactory = openExactIndex,
): Promise<{
  stats: SyncStats;
  config: ReturnType<typeof resolveConfig>;
}> {
  const config = resolveConfig(overrides);
  const paths = getDataPaths(config.dataDir);
  ensureDir(paths.normalizedDir);
  ensureDir(paths.manifestsDir);
  ensureDir(paths.indexDir);
  ensureDir(paths.tempDir);

  const catalogData = loadCatalog(config);
  const previousCatalog = readCatalogFile(paths.catalogPath);
  const previousByDocKey = mapEntriesByDocKey(previousCatalog);
  const nextEntries: CatalogEntry[] = [];
  const changedAttachments: AttachmentCatalogEntry[] = [];
  const staleDocKeys = new Set(previousCatalog.entries.map((entry) => entry.docKey));

  const stats: SyncStats = {
    totalRecords: catalogData.records.length,
    totalAttachments: catalogData.attachments.length,
    supportedAttachments: 0,
    readyAttachments: 0,
    missingAttachments: 0,
    unsupportedAttachments: 0,
    errorAttachments: 0,
    indexedAttachments: 0,
    updatedAttachments: 0,
    skippedAttachments: 0,
    removedAttachments: 0,
  };

  for (const attachment of catalogData.attachments) {
    staleDocKeys.delete(attachment.docKey);
    if (attachment.supported) stats.supportedAttachments += 1;

    if (!attachment.supported) {
      nextEntries.push(
        toCatalogEntry(attachment, {
          extractStatus: "unsupported",
        }),
      );
      stats.unsupportedAttachments += 1;
      continue;
    }

    const current = statSync(attachment.filePath, { throwIfNoEntry: false });
    if (!current || !attachment.exists) {
      const previous = previousByDocKey.get(attachment.docKey);
      deleteIfExists(previous?.normalizedPath);
      deleteIfExists(previous?.manifestPath);
      nextEntries.push(
        toCatalogEntry(attachment, {
          extractStatus: "missing",
        }),
      );
      stats.missingAttachments += 1;
      continue;
    }

    const previous = previousByDocKey.get(attachment.docKey);
    const hasIndexedArtifacts =
      previous?.extractStatus === "ready" &&
      !!previous.manifestPath &&
      !!previous.normalizedPath &&
      exists(previous.manifestPath) &&
      exists(previous.normalizedPath);
    const needsExtract =
      !previous ||
      previous.extractStatus !== "ready" ||
      previous.size !== current.size ||
      previous.mtimeMs !== Math.trunc(current.mtimeMs) ||
      !hasIndexedArtifacts;

    if (needsExtract) {
      changedAttachments.push(attachment);
      continue;
    }

    nextEntries.push(
      toCatalogEntry(attachment, {
        extractStatus: "ready",
        size: current.size,
        mtimeMs: Math.trunc(current.mtimeMs),
        sourceHash: previous.sourceHash ?? null,
        lastIndexedAt: previous.lastIndexedAt ?? null,
        normalizedPath: previous.normalizedPath,
        manifestPath: previous.manifestPath,
      }),
    );
    stats.readyAttachments += 1;
    stats.skippedAttachments += 1;
  }

  if (changedAttachments.length > 0) {
    requireJava();
  }

  for (const batch of groupForOdlBatches(changedAttachments)) {
    const extracted = await extractBatch(batch, paths.tempDir, paths.manifestsDir, paths.normalizedDir);
    for (const attachment of batch) {
      const current = statSync(attachment.filePath);
      const sourceHash = await sha1File(attachment.filePath);
      const written = extracted.get(attachment.docKey);
      if (!written) {
        throw new Error(`Missing extracted output for ${attachment.filePath}`);
      }

      nextEntries.push(
        toCatalogEntry(attachment, {
          extractStatus: "ready",
          size: current.size,
          mtimeMs: Math.trunc(current.mtimeMs),
          sourceHash,
          lastIndexedAt: new Date().toISOString(),
          normalizedPath: written.normalizedPath,
          manifestPath: written.manifestPath,
        }),
      );
      stats.readyAttachments += 1;
      stats.updatedAttachments += 1;
      stats.indexedAttachments += 1;
    }
  }

  for (const docKey of staleDocKeys) {
    const previous = previousByDocKey.get(docKey);
    deleteIfExists(previous?.normalizedPath);
    deleteIfExists(previous?.manifestPath);
    stats.removedAttachments += 1;
  }

  nextEntries.sort((a, b) => a.filePath.localeCompare(b.filePath));
  const nextCatalog: CatalogFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: nextEntries,
  };
  writeCatalogFile(paths.catalogPath, nextCatalog);

  const readyEntries = nextEntries.filter((entry) => entry.extractStatus === "ready");
  const exactIndex = await exactFactory(config);
  try {
    logSyncPhase("Sync: rebuilding exact search index...");
    await exactIndex.rebuildExactIndex(readyEntries);
  } finally {
    await exactIndex.close();
  }

  const qmd = await qmdFactory(config);
  try {
    logSyncPhase("Sync: updating search index...");
    await qmd.update();
    await syncQmdContexts(qmd, readyEntries);
    if (readyEntries.length > 0) {
      logSyncPhase("Sync: generating embeddings...");
      await qmd.embed();
    }
  } finally {
    await qmd.close();
  }

  const finalCounts = summarizeCatalog(nextCatalog);
  stats.readyAttachments = finalCounts.readyAttachments;
  stats.missingAttachments = finalCounts.missingAttachments;
  stats.unsupportedAttachments = finalCounts.unsupportedAttachments;
  stats.errorAttachments = finalCounts.errorAttachments;

  return { stats, config };
}
