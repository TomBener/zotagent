import { buildArgs, type ConvertOptions } from "@opendataloader/pdf";
import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { loadCatalog } from "./catalog.js";
import { getDataPaths, resolveConfig, type ConfigOverrides } from "./config.js";
import { buildMarkdownManifest, buildPdfManifest } from "./manifest.js";
import { extractEpub } from "./epub.js";
import { extractHtml } from "./html-extract.js";
import { openQmdClient, type QmdFactory } from "./qmd.js";
import { mapEntriesByDocKey, readCatalogFile, summarizeCatalog, writeCatalogFile } from "./state.js";
import { openExactIndex, type ExactIndexFactory } from "./exact-db.js";
import type { AttachmentCatalogEntry, AttachmentManifest, CatalogEntry, CatalogFile, SyncStats } from "./types.js";
import {
  compactHomePath,
  ensureDir,
  ensureParentDir,
  exists,
  stemForFile,
} from "./utils.js";

const HIDE_JAVA_DOCK_ICON_FLAG = "-Dapple.awt.UIElement=true";
const ODL_JAR_NAME = "opendataloader-pdf-cli.jar";
const ODL_SINGLE_PDF_TIMEOUT_MS = 180_000;
const ODL_EXTRA_BATCH_TIMEOUT_MS = 30_000;
const ODL_FORCE_KILL_GRACE_MS = 1_000;
const ODL_DEFAULT_BATCH_SIZE = 8;
const ODL_SINGLE_BATCH_SIZE_BYTES = 20 * 1024 * 1024;

const require = createRequire(import.meta.url);
const ODL_PACKAGE_ENTRY = require.resolve("@opendataloader/pdf");
const ODL_JAR_PATH = resolve(dirname(ODL_PACKAGE_ENTRY), "..", "lib", ODL_JAR_NAME);

function writeConsoleSyncLine(message: string): void {
  if (process.stderr.isTTY) {
    process.stderr.write(`${message}\n`);
  }
}

function buildSyncLogFileName(date: Date): string {
  return `sync-${date.toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "Z")}.log`;
}

function formatLogTimestamp(date: Date = new Date()): string {
  return date.toISOString();
}

function formatLogSectionTitle(title: string): string {
  return `\n## ${title}\n`;
}

type SyncRunStatus = "starting" | "running" | "completed" | "failed";

type SyncRunProgressSnapshot = {
  status: SyncRunStatus;
  batchIndex?: number;
  batchCount?: number;
  currentFilePath?: string;
  processedAttachments?: number;
  readyAttachments?: number;
  errorAttachments?: number;
  missingAttachments?: number;
  unsupportedAttachments?: number;
  skippedAttachments?: number;
  note?: string;
};

type SyncFileOutcomeKind = "skipped" | "error" | "missing" | "unsupported";

type SyncFileOutcome = {
  kind: SyncFileOutcomeKind;
  filePath: string;
  detail?: string;
};

class SyncLogger {
  readonly logPath: string;
  readonly latestLogPath: string;

  constructor(
    private readonly paths: ReturnType<typeof getDataPaths>,
    private readonly config: ReturnType<typeof resolveConfig>,
    private readonly startedAt: Date,
  ) {
    ensureDir(paths.logsDir);
    this.logPath = resolve(paths.logsDir, buildSyncLogFileName(startedAt));
    this.latestLogPath = paths.latestSyncLogPath;
    writeFileSync(this.logPath, "", "utf-8");
    this.writeHeader();
  }

  private append(line: string): void {
    appendFileSync(this.logPath, line, "utf-8");
  }

  private writeHeader(): void {
    this.append("# zotagent sync log\n");
    this.append(`startedAt: ${formatLogTimestamp(this.startedAt)}\n`);
    this.append(`dataDir: ${this.config.dataDir}\n`);
    this.append(`attachmentsRoot: ${this.config.attachmentsRoot}\n`);
    this.append(`bibliographyJsonPath: ${this.config.bibliographyJsonPath}\n`);
    if (this.config.warnings.length > 0) {
      this.append(formatLogSectionTitle("Config Warnings"));
      for (const warning of this.config.warnings) {
        this.append(`- ${warning}\n`);
      }
    }
    this.append(formatLogSectionTitle("Events"));
  }

  info(message: string, options: { console?: boolean } = {}): void {
    const consoleOutput = options.console ?? false;
    const line = `[${formatLogTimestamp()}] INFO ${message}`;
    this.append(`${line}\n`);
    if (consoleOutput) {
      writeConsoleSyncLine(`Sync: ${message}`);
    }
  }

  warn(message: string, options: { console?: boolean } = {}): void {
    const consoleOutput = options.console ?? true;
    const line = `[${formatLogTimestamp()}] WARN ${message}`;
    this.append(`${line}\n`);
    if (consoleOutput) {
      writeConsoleSyncLine(`Sync: ${message}`);
    }
  }

  error(message: string, options: { console?: boolean } = {}): void {
    const consoleOutput = options.console ?? true;
    const line = `[${formatLogTimestamp()}] ERROR ${message}`;
    this.append(`${line}\n`);
    if (consoleOutput) {
      writeConsoleSyncLine(`Sync: ${message}`);
    }
  }

  detail(title: string, content: string): void {
    this.append(formatLogSectionTitle(title));
    this.append(`${content.trimEnd()}\n`);
  }

  progress(snapshot: SyncRunProgressSnapshot): void {
    const fields = [
      `status=${snapshot.status}`,
      snapshot.batchIndex !== undefined ? `batch=${snapshot.batchIndex}` : undefined,
      snapshot.batchCount !== undefined ? `batchCount=${snapshot.batchCount}` : undefined,
      snapshot.processedAttachments !== undefined ? `processed=${snapshot.processedAttachments}` : undefined,
      snapshot.readyAttachments !== undefined ? `ready=${snapshot.readyAttachments}` : undefined,
      snapshot.errorAttachments !== undefined ? `errors=${snapshot.errorAttachments}` : undefined,
      snapshot.missingAttachments !== undefined ? `missing=${snapshot.missingAttachments}` : undefined,
      snapshot.unsupportedAttachments !== undefined ? `unsupported=${snapshot.unsupportedAttachments}` : undefined,
      snapshot.skippedAttachments !== undefined ? `skipped=${snapshot.skippedAttachments}` : undefined,
      snapshot.currentFilePath ? `file=${compactHomePath(snapshot.currentFilePath)}` : undefined,
      snapshot.note ? `note=${snapshot.note}` : undefined,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    this.append(`[${formatLogTimestamp()}] PROGRESS ${fields.join(" ")}\n`);
  }

  private writeFileListSection(title: string, items: SyncFileOutcome[]): void {
    if (items.length === 0) return;
    this.append(formatLogSectionTitle(title));
    for (const item of items) {
      const line = item.detail
        ? `- ${compactHomePath(item.filePath)}: ${item.detail}`
        : `- ${compactHomePath(item.filePath)}`;
      this.append(`${line}\n`);
    }
  }

  finalize(status: "ok" | "failed", outcomes: SyncFileOutcome[], stats?: SyncStats): void {
    this.writeFileListSection(
      "Skipped Files",
      outcomes.filter((item) => item.kind === "skipped"),
    );
    this.writeFileListSection(
      "Errored Files",
      outcomes.filter((item) => item.kind === "error"),
    );
    this.writeFileListSection(
      "Missing Files",
      outcomes.filter((item) => item.kind === "missing"),
    );
    this.writeFileListSection(
      "Unsupported Files",
      outcomes.filter((item) => item.kind === "unsupported"),
    );
    this.append(formatLogSectionTitle("Summary"));
    this.append(`finishedAt: ${formatLogTimestamp()}\n`);
    this.append(`status: ${status}\n`);
    if (stats) {
      this.append(`totalRecords: ${stats.totalRecords}\n`);
      this.append(`totalAttachments: ${stats.totalAttachments}\n`);
      this.append(`supportedAttachments: ${stats.supportedAttachments}\n`);
      this.append(`readyAttachments: ${stats.readyAttachments}\n`);
      this.append(`errorAttachments: ${stats.errorAttachments}\n`);
      this.append(`indexedAttachments: ${stats.indexedAttachments}\n`);
      this.append(`updatedAttachments: ${stats.updatedAttachments}\n`);
      this.append(`skippedAttachments: ${stats.skippedAttachments}\n`);
      this.append(`removedAttachments: ${stats.removedAttachments}\n`);
    }
    copyFileSync(this.logPath, this.latestLogPath);
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
  return platform === "darwin" && env.ZOTAGENT_SHOW_JAVA_DOCK_ICON !== "1";
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

type RunProcessWithTimeoutOptions = {
  command: string;
  args: string[];
  timeoutMs: number;
  label?: string;
  env?: NodeJS.ProcessEnv;
  streamOutput?: boolean;
  spawnImpl?: typeof spawn;
  maxBufferedOutputBytes?: number;
};

const DEFAULT_MAX_BUFFERED_OUTPUT_BYTES = 256 * 1024;

function appendCappedOutput(
  current: string,
  chunk: string,
  maxBufferedOutputBytes: number,
): { text: string; truncatedBytes: number } {
  const next = current + chunk;
  const nextBytes = Buffer.byteLength(next);
  if (nextBytes <= maxBufferedOutputBytes) {
    return { text: next, truncatedBytes: 0 };
  }

  const overflowBytes = nextBytes - maxBufferedOutputBytes;
  let dropChars = 0;
  let droppedBytes = 0;
  while (dropChars < next.length && droppedBytes < overflowBytes) {
    dropChars += 1;
    droppedBytes = Buffer.byteLength(next.slice(0, dropChars));
  }

  return {
    text: next.slice(dropChars),
    truncatedBytes: droppedBytes,
  };
}

function formatBufferedOutput(text: string, truncatedBytes: number): string {
  if (truncatedBytes <= 0) {
    return text;
  }
  return `[truncated ${truncatedBytes} earlier bytes]\n${text}`;
}

export async function runProcessWithTimeout({
  command,
  args,
  timeoutMs,
  label,
  env,
  streamOutput = false,
  spawnImpl = spawn,
  maxBufferedOutputBytes = DEFAULT_MAX_BUFFERED_OUTPUT_BYTES,
}: RunProcessWithTimeoutOptions): Promise<string> {
  const processLabel = label ?? command;

  return await new Promise((resolvePromise, reject) => {
    const child = spawnImpl(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let truncatedStdoutBytes = 0;
    let truncatedStderrBytes = 0;
    let settled = false;
    let timedOut = false;

    const forceKill = setTimeout(() => {
      if (timedOut && child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, timeoutMs + ODL_FORCE_KILL_GRACE_MS);

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timeout);
      clearTimeout(forceKill);
    }

    function rejectOnce(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function resolveOnce(value: string): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    }

    child.stdout.on("data", (data) => {
      const chunk = data.toString();
      const next = appendCappedOutput(stdout, chunk, maxBufferedOutputBytes);
      stdout = next.text;
      truncatedStdoutBytes += next.truncatedBytes;
      if (streamOutput) process.stdout.write(chunk);
    });

    child.stderr.on("data", (data) => {
      const chunk = data.toString();
      const next = appendCappedOutput(stderr, chunk, maxBufferedOutputBytes);
      stderr = next.text;
      truncatedStderrBytes += next.truncatedBytes;
      if (streamOutput) process.stderr.write(chunk);
    });

    child.on("error", (error) => {
      if (error.message.includes("ENOENT")) {
        rejectOnce(new Error(`'${command}' command not found. Please ensure it is installed and in PATH.`));
        return;
      }
      rejectOnce(error);
    });

    child.on("close", (code, signal) => {
      const errorOutput = (
        stderr.length > 0
          ? formatBufferedOutput(stderr, truncatedStderrBytes)
          : formatBufferedOutput(stdout, truncatedStdoutBytes)
      ).trim();

      if (timedOut) {
        const suffix = errorOutput.length > 0 ? `\n\n${errorOutput}` : "";
        rejectOnce(new Error(`${processLabel} timed out after ${timeoutMs}ms.${suffix}`));
        return;
      }

      if (code === 0) {
        resolveOnce(formatBufferedOutput(stdout, truncatedStdoutBytes));
        return;
      }

      if (signal) {
        const suffix = errorOutput.length > 0 ? `\n\n${errorOutput}` : "";
        rejectOnce(new Error(`${processLabel} was terminated by signal ${signal}.${suffix}`));
        return;
      }

      const suffix = errorOutput.length > 0 ? `\n\n${errorOutput}` : "";
      rejectOnce(new Error(`${processLabel} exited with code ${code}.${suffix}`));
    });
  });
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

function tryReadManifest(path: string): AttachmentManifest | undefined {
  if (!exists(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as AttachmentManifest;
  } catch {
    return undefined;
  }
}

function hasReusableNormalizedOutput(path: string): boolean {
  const stats = statSync(path, { throwIfNoEntry: false });
  return Boolean(stats && stats.size > 0);
}

function assertNonEmptyExtractedOutput(
  filePath: string,
  built: { markdown: string; manifest: AttachmentManifest },
): void {
  if (built.markdown.trim().length > 0 && built.manifest.blocks.length > 0) {
    return;
  }
  throw new Error(`Extracted output was empty for ${filePath}`);
}

function hasReusableArtifacts(
  attachment: AttachmentCatalogEntry,
  normalizedPath: string | undefined,
  manifestPath: string | undefined,
): normalizedPath is string {
  if (!normalizedPath || !manifestPath) return false;
  if (!exists(normalizedPath) || !exists(manifestPath)) return false;
  if (!hasReusableNormalizedOutput(normalizedPath)) return false;

  const manifest = tryReadManifest(manifestPath);
  if (!manifest) return false;

  return manifest.docKey === attachment.docKey && manifest.itemKey === attachment.itemKey;
}

function isLikelyBookAttachment(attachment: AttachmentCatalogEntry): boolean {
  if (attachment.type === "book" || attachment.type === "chapter") return true;
  return attachment.filePath
    .split("/")
    .some((segment) => segment.toLowerCase() === "book");
}

function shouldExtractAttachmentAlone(attachment: AttachmentCatalogEntry): boolean {
  if (isLikelyBookAttachment(attachment)) return true;
  const current = statSync(attachment.filePath, { throwIfNoEntry: false });
  return Boolean(current && current.size >= ODL_SINGLE_BATCH_SIZE_BYTES);
}

function groupForOdlBatches(
  attachments: AttachmentCatalogEntry[],
  maxBatchSize = ODL_DEFAULT_BATCH_SIZE,
): AttachmentCatalogEntry[][] {
  const out: AttachmentCatalogEntry[][] = [];
  let current: AttachmentCatalogEntry[] = [];
  let stems = new Set<string>();

  for (const attachment of attachments) {
    if (maxBatchSize <= 1 || shouldExtractAttachmentAlone(attachment)) {
      if (current.length > 0) {
        out.push(current);
        current = [];
        stems = new Set<string>();
      }
      out.push([attachment]);
      continue;
    }

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

function getOdlTimeoutMs(batchSize: number): number {
  return ODL_SINGLE_PDF_TIMEOUT_MS + Math.max(0, batchSize - 1) * ODL_EXTRA_BATCH_TIMEOUT_MS;
}

export async function runOdlConvert(
  inputPaths: string[],
  options: ConvertOptions,
  executionOptions: {
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    spawnImpl?: typeof spawn;
  } = {},
): Promise<string> {
  if (inputPaths.length === 0) {
    throw new Error("At least one input path must be provided.");
  }

  for (const inputPath of inputPaths) {
    if (!exists(inputPath)) {
      throw new Error(`Input file or folder not found: ${inputPath}`);
    }
  }

  if (!exists(ODL_JAR_PATH)) {
    throw new Error(`OpenDataLoader JAR not found at ${ODL_JAR_PATH}`);
  }

  return await runProcessWithTimeout({
    command: "java",
    args: ["-jar", ODL_JAR_PATH, ...inputPaths, ...buildArgs(options)],
    timeoutMs: executionOptions.timeoutMs ?? getOdlTimeoutMs(inputPaths.length),
    label: "OpenDataLoader PDF extraction",
    env: executionOptions.env,
    streamOutput: false,
    spawnImpl: executionOptions.spawnImpl,
  });
}

type ExtractedPaths = { manifestPath: string; normalizedPath: string };
type ExtractBatchOptions = {
  timeoutMs?: number;
};
type ExtractBatchFn = (
  batch: AttachmentCatalogEntry[],
  tempRoot: string,
  manifestsDir: string,
  normalizedDir: string,
  options?: ExtractBatchOptions,
) => Promise<Map<string, ExtractedPaths>>;

export type SyncRunOptions = {
  retryErrors?: boolean;
  pdfTimeoutMs?: number;
  pdfBatchSize?: number;
};

async function extractBatch(
  batch: AttachmentCatalogEntry[],
  tempRoot: string,
  manifestsDir: string,
  normalizedDir: string,
  options: ExtractBatchOptions = {},
): Promise<Map<string, ExtractedPaths>> {
  const tempDir = mkdtempSync(join(tempRoot, "odl-"));
  const byDocKey = new Map<string, ExtractedPaths>();

  try {
    await withHiddenJavaDockIcon(() =>
      runOdlConvert(
        batch.map((attachment) => attachment.filePath),
        {
          outputDir: tempDir,
          format: "markdown,json",
        },
        options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
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
      assertNonEmptyExtractedOutput(attachment.filePath, built);

      writeFileSync(normalizedPath, built.markdown, "utf-8");
      writeFileSync(manifestPath, JSON.stringify(built.manifest, null, 2), "utf-8");
      byDocKey.set(attachment.docKey, { manifestPath, normalizedPath });
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  return byDocKey;
}

function summarizeSyncError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/\r/g, "").replace(/\\n/g, "\n");
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const preferred = [...lines]
    .reverse()
    .find((line) =>
      /(error|exception|failed|caused by|timed out)/i.test(line) &&
      !/^warning:/i.test(line) &&
      !/^info:/i.test(line) &&
      !/^apr \d{2},/i.test(line),
    );
  const fallback = [...lines]
    .reverse()
    .find((line) => !/^picked up java_tool_options/i.test(line) && !/^apr \d{2},/i.test(line));
  const candidate = preferred ?? fallback ?? raw.trim();
  return candidate.replace(/\s+/g, " ").trim();
}

function toExtractErrorMessage(filePath: string, error: unknown): string {
  return `Extraction failed for ${compactHomePath(filePath)}: ${summarizeSyncError(error)}`;
}

async function extractNonPdfAttachment(
  attachment: AttachmentCatalogEntry,
  manifestsDir: string,
  normalizedDir: string,
): Promise<ExtractedPaths> {
  let markdown: string;

  if (attachment.fileExt === "epub") {
    markdown = await extractEpub(attachment.filePath);
  } else if (attachment.fileExt === "html") {
    markdown = await extractHtml(attachment.filePath);
  } else if (attachment.fileExt === "txt") {
    markdown = readFileSync(attachment.filePath, "utf-8");
  } else {
    throw new Error(`Unsupported file type for extraction: ${attachment.fileExt}`);
  }

  const normalizedPath = resolve(normalizedDir, `${attachment.docKey}.md`);
  const manifestPath = resolve(manifestsDir, `${attachment.docKey}.json`);
  ensureParentDir(normalizedPath);
  ensureParentDir(manifestPath);

  const built = buildMarkdownManifest(attachment, markdown, normalizedPath);
  assertNonEmptyExtractedOutput(attachment.filePath, built);
  writeFileSync(normalizedPath, built.markdown, "utf-8");
  writeFileSync(manifestPath, JSON.stringify(built.manifest, null, 2), "utf-8");

  return { manifestPath, normalizedPath };
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

function writeProgressCatalog(path: string, entries: CatalogEntry[]): void {
  const snapshot: CatalogFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [...entries].sort((a, b) => a.filePath.localeCompare(b.filePath)),
  };
  writeCatalogFile(path, snapshot);
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

async function embedQmdUntilSettled(
  qmd: Awaited<ReturnType<QmdFactory>>,
  logger: SyncLogger,
): Promise<void> {
  let pass = 0;

  while (true) {
    const before = await qmd.getStatus();
    if (before.needsEmbedding <= 0) return;

    pass += 1;
    logger.info(
      pass === 1
        ? `Generating embeddings for ${before.needsEmbedding} document(s).`
        : `Continuing embeddings (pass ${pass}, ${before.needsEmbedding} document(s) remaining).`,
      { console: true },
    );

    await qmd.embed();

    const after = await qmd.getStatus();
    if (after.needsEmbedding <= 0) {
      if (pass > 1) {
        logger.info(`Embedding complete after ${pass} pass(es).`, { console: true });
      }
      return;
    }

    if (after.needsEmbedding >= before.needsEmbedding) {
      logger.warn(
        `Embedding made no further progress; ${after.needsEmbedding} document(s) still need embeddings.`,
      );
      return;
    }

    logger.info(
      `Embedding pass ${pass} finished: ${before.needsEmbedding - after.needsEmbedding} document(s) completed, ${after.needsEmbedding} remaining.`,
      { console: true },
    );
  }
}

export async function runSync(
  overrides: ConfigOverrides = {},
  qmdFactory: QmdFactory = openQmdClient,
  exactFactory: ExactIndexFactory = openExactIndex,
  extractBatchFn: ExtractBatchFn = extractBatch,
  requireJavaFn: () => void = requireJava,
  options: SyncRunOptions = {},
): Promise<{
  stats: SyncStats;
  config: ReturnType<typeof resolveConfig>;
  logPath: string;
}> {
  const config = resolveConfig(overrides);
  const paths = getDataPaths(config.dataDir);
  const logger = new SyncLogger(paths, config, new Date());
  let finalStatusWritten = false;
  let latestProgress: SyncRunProgressSnapshot = { status: "starting", note: "sync initialized" };
  let activeFileOutcomes: SyncFileOutcome[] = [];
  let activeStats: SyncStats | undefined;

  const writeProgress = (partial: Partial<SyncRunProgressSnapshot> = {}): void => {
    latestProgress = {
      ...latestProgress,
      ...partial,
    };
    logger.progress(latestProgress);
  };

  const finalizeOnce = (status: "ok" | "failed", outcomes: SyncFileOutcome[], stats?: SyncStats): void => {
    if (finalStatusWritten) return;
    finalStatusWritten = true;
    logger.finalize(status, outcomes, stats);
  };

  const signalNames = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;
  const signalHandlers = new Map<string, () => void>();
  let removedLifecycleHooks = false;

  const removeLifecycleHooks = (): void => {
    if (removedLifecycleHooks) return;
    removedLifecycleHooks = true;
    process.off("beforeExit", onBeforeExit);
    process.off("exit", onExit);
    for (const [signal, handler] of signalHandlers.entries()) {
      process.off(signal, handler);
    }
    signalHandlers.clear();
  };

  const onBeforeExit = (code: number): void => {
    writeProgress({ note: `beforeExit code=${code}` });
    logger.info(`Process beforeExit with code ${code}.`);
  };

  const onExit = (code: number): void => {
    const status = code === 0 ? "completed" : "failed";
    writeProgress({ status, note: `process exit code=${code}` });
    logger.info(`Process exit with code ${code}.`);
  };

  process.on("beforeExit", onBeforeExit);
  process.on("exit", onExit);
  for (const signal of signalNames) {
    const handler = () => {
      writeProgress({ status: "failed", note: `received ${signal}` });
      logger.warn(`Received ${signal}; sync process is being interrupted.`);
      finalizeOnce("failed", activeFileOutcomes, activeStats);
      removeLifecycleHooks();
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exit(1);
      }
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    ensureDir(paths.normalizedDir);
    ensureDir(paths.manifestsDir);
    ensureDir(paths.indexDir);
    ensureDir(paths.tempDir);
    ensureDir(paths.logsDir);
    logger.info("Prepared data directories.");

    const catalogData = loadCatalog(config);
    logger.info(
      `Loaded bibliography with ${catalogData.records.length} records and ${catalogData.attachments.length} attachments.`,
    );
    const previousCatalog = readCatalogFile(paths.catalogPath);
    const previousByDocKey = mapEntriesByDocKey(previousCatalog);
    const nextEntries: CatalogEntry[] = [];
    const exactUpserts = new Map<string, CatalogEntry>();
    const exactDeletes = new Set<string>();
    const changedAttachments: AttachmentCatalogEntry[] = [];
    const staleDocKeys = new Set(previousCatalog.entries.map((entry) => entry.docKey));
    const fileOutcomes: SyncFileOutcome[] = [];
    activeFileOutcomes = fileOutcomes;

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
    activeStats = stats;

    writeProgress({
      status: "running",
      processedAttachments: 0,
      readyAttachments: 0,
      errorAttachments: 0,
      missingAttachments: 0,
      unsupportedAttachments: 0,
      skippedAttachments: 0,
      note: "catalog loaded",
    });

    for (const attachment of catalogData.attachments) {
      staleDocKeys.delete(attachment.docKey);
      if (attachment.supported) stats.supportedAttachments += 1;

      if (!attachment.supported) {
        if (previousByDocKey.get(attachment.docKey)?.extractStatus === "ready") {
          exactDeletes.add(attachment.docKey);
        }
        fileOutcomes.push({
          kind: "unsupported",
          filePath: attachment.filePath,
          detail: `unsupported file type: ${attachment.fileExt}`,
        });
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
        if (previousByDocKey.get(attachment.docKey)?.extractStatus === "ready") {
          exactDeletes.add(attachment.docKey);
        }
        fileOutcomes.push({
          kind: "missing",
          filePath: attachment.filePath,
          detail: "file missing at sync time",
        });
        nextEntries.push(
          toCatalogEntry(attachment, {
            extractStatus: "missing",
          }),
        );
        stats.missingAttachments += 1;
        continue;
      }

      const previous = previousByDocKey.get(attachment.docKey);
      const fallbackNormalizedPath = resolve(paths.normalizedDir, `${attachment.docKey}.md`);
      const fallbackManifestPath = resolve(paths.manifestsDir, `${attachment.docKey}.json`);
      const currentMtimeMs = Math.trunc(current.mtimeMs);
      const previousIsUnchanged =
        previous !== undefined &&
        previous.size === current.size &&
        previous.mtimeMs === currentMtimeMs;
      const previousIsReadyAndUnchanged =
        previous?.extractStatus === "ready" &&
        previousIsUnchanged &&
        hasReusableArtifacts(attachment, previous.normalizedPath, previous.manifestPath);
      const previousIsErrorAndUnchanged =
        previous?.extractStatus === "error" &&
        previousIsUnchanged;
      const fallbackArtifactsReusable = hasReusableArtifacts(
        attachment,
        fallbackNormalizedPath,
        fallbackManifestPath,
      );

      if (previousIsErrorAndUnchanged && !fallbackArtifactsReusable && !options.retryErrors) {
        nextEntries.push(
          toCatalogEntry(attachment, {
            extractStatus: "error",
            size: current.size,
            mtimeMs: currentMtimeMs,
            sourceHash: previous.sourceHash ?? null,
            lastIndexedAt: previous.lastIndexedAt ?? null,
            error: previous.error ?? "Previous extraction error; file unchanged.",
          }),
        );
        fileOutcomes.push({
          kind: "skipped",
          filePath: attachment.filePath,
          detail: "skipped unchanged previous extraction error",
        });
        stats.errorAttachments += 1;
        stats.skippedAttachments += 1;
        continue;
      }

      if (!previousIsReadyAndUnchanged && !fallbackArtifactsReusable) {
        changedAttachments.push(attachment);
        continue;
      }

      const nextEntry = toCatalogEntry(attachment, {
        extractStatus: "ready",
        size: current.size,
        mtimeMs: currentMtimeMs,
        sourceHash: previousIsReadyAndUnchanged ? previous.sourceHash ?? null : null,
        lastIndexedAt: previousIsReadyAndUnchanged ? previous.lastIndexedAt ?? null : null,
        normalizedPath: previousIsReadyAndUnchanged ? previous.normalizedPath : fallbackNormalizedPath,
        manifestPath: previousIsReadyAndUnchanged ? previous.manifestPath : fallbackManifestPath,
      });
      nextEntries.push(nextEntry);
      if (!previousIsReadyAndUnchanged) {
        exactUpserts.set(nextEntry.docKey, nextEntry);
      }
      fileOutcomes.push({
        kind: "skipped",
        filePath: attachment.filePath,
        detail: "reused existing indexed output",
      });
      stats.readyAttachments += 1;
      stats.skippedAttachments += 1;
    }

    const pdfAttachments = changedAttachments.filter((a) => a.fileExt === "pdf");
    const nonPdfAttachments = changedAttachments.filter((a) => a.fileExt !== "pdf");

    if (changedAttachments.length > 0) {
      const parts: string[] = [];
      if (pdfAttachments.length > 0) parts.push(`${pdfAttachments.length} PDF(s)`);
      if (nonPdfAttachments.length > 0) parts.push(`${nonPdfAttachments.length} non-PDF(s)`);
      logger.info(`Preparing to extract ${parts.join(" and ")}.`, { console: true });
      if (pdfAttachments.length > 0) requireJavaFn();
    } else {
      logger.info("No extraction needed; reusing existing indexed files where possible.", { console: true });
    }

    for (const attachment of nonPdfAttachments) {
      try {
        logger.info(`Extracting ${attachment.fileExt}: ${compactHomePath(attachment.filePath)}.`);
        const written = await extractNonPdfAttachment(attachment, paths.manifestsDir, paths.normalizedDir);
        await recordReadyAttachment(attachment, written);
      } catch (error) {
        recordErroredAttachment(attachment, error);
      }
    }
    if (nonPdfAttachments.length > 0) {
      writeProgressCatalog(paths.catalogPath, nextEntries);
    }

    async function recordReadyAttachment(
      attachment: AttachmentCatalogEntry,
      written: ExtractedPaths,
    ): Promise<void> {
      const current = statSync(attachment.filePath);
      const sourceHash = await sha1File(attachment.filePath);

      const nextEntry = toCatalogEntry(attachment, {
        extractStatus: "ready",
        size: current.size,
        mtimeMs: Math.trunc(current.mtimeMs),
        sourceHash,
        lastIndexedAt: new Date().toISOString(),
        normalizedPath: written.normalizedPath,
        manifestPath: written.manifestPath,
      });
      nextEntries.push(nextEntry);
      exactUpserts.set(nextEntry.docKey, nextEntry);
      stats.readyAttachments += 1;
      stats.updatedAttachments += 1;
      stats.indexedAttachments += 1;
    }

    function recordErroredAttachment(attachment: AttachmentCatalogEntry, error: unknown): void {
      const previous = previousByDocKey.get(attachment.docKey);
      if (previous?.extractStatus === "ready") {
        exactDeletes.add(attachment.docKey);
      }
      deleteIfExists(previous?.normalizedPath);
      deleteIfExists(previous?.manifestPath);

      const current = statSync(attachment.filePath, { throwIfNoEntry: false });
      const message = toExtractErrorMessage(attachment.filePath, error);
      logger.error(message);
      logger.detail(
        `Extraction Error: ${compactHomePath(attachment.filePath)}`,
        error instanceof Error ? error.message : String(error),
      );
      fileOutcomes.push({
        kind: "error",
        filePath: attachment.filePath,
        detail: summarizeSyncError(error),
      });

      nextEntries.push(
        toCatalogEntry(attachment, {
          extractStatus: "error",
          size: current?.size ?? null,
          mtimeMs: current ? Math.trunc(current.mtimeMs) : null,
          sourceHash: null,
          lastIndexedAt: null,
          error: message,
        }),
      );
    }

    const batches = groupForOdlBatches(pdfAttachments, options.pdfBatchSize ?? ODL_DEFAULT_BATCH_SIZE);
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex]!;
      writeProgress({
        status: "running",
        batchIndex: batchIndex + 1,
        batchCount: batches.length,
        currentFilePath: batch[0]?.filePath,
        processedAttachments:
          stats.readyAttachments +
          stats.errorAttachments +
          stats.missingAttachments +
          stats.unsupportedAttachments,
        readyAttachments: stats.readyAttachments,
        errorAttachments: stats.errorAttachments,
        missingAttachments: stats.missingAttachments,
        unsupportedAttachments: stats.unsupportedAttachments,
        skippedAttachments: stats.skippedAttachments,
        note: `starting batch with ${batch.length} pdf(s)`,
      });
      logger.info(`Extracting batch ${batchIndex + 1}/${batches.length} (${batch.length} PDF(s)).`, {
        console: true,
      });
      try {
        const extracted = await extractBatchFn(
          batch,
          paths.tempDir,
          paths.manifestsDir,
          paths.normalizedDir,
          options.pdfTimeoutMs !== undefined ? { timeoutMs: options.pdfTimeoutMs } : undefined,
        );
        for (const attachment of batch) {
          const written = extracted.get(attachment.docKey);
          if (!written) {
            throw new Error(`Missing extracted output for ${attachment.filePath}`);
          }
          await recordReadyAttachment(attachment, written);
        }
      } catch (batchError) {
        if (batch.length > 1) {
          logger.warn(`Batch ${batchIndex + 1} failed; retrying ${batch.length} PDF(s) individually.`);
          logger.detail(
            `Batch ${batchIndex + 1} Error`,
            batchError instanceof Error ? batchError.message : String(batchError),
          );
          for (const attachment of batch) {
            try {
              writeProgress({
                status: "running",
                batchIndex: batchIndex + 1,
                batchCount: batches.length,
                currentFilePath: attachment.filePath,
                processedAttachments:
                  stats.readyAttachments +
                  stats.errorAttachments +
                  stats.missingAttachments +
                  stats.unsupportedAttachments,
                readyAttachments: stats.readyAttachments,
                errorAttachments: stats.errorAttachments,
                missingAttachments: stats.missingAttachments,
                unsupportedAttachments: stats.unsupportedAttachments,
                skippedAttachments: stats.skippedAttachments,
                note: "retrying individually after batch failure",
              });
              logger.info(`Retrying ${compactHomePath(attachment.filePath)} individually.`);
              const extracted = await extractBatchFn(
                [attachment],
                paths.tempDir,
                paths.manifestsDir,
                paths.normalizedDir,
                options.pdfTimeoutMs !== undefined ? { timeoutMs: options.pdfTimeoutMs } : undefined,
              );
              const written = extracted.get(attachment.docKey);
              if (!written) {
                throw new Error(`Missing extracted output for ${attachment.filePath}`);
              }
              await recordReadyAttachment(attachment, written);
            } catch (singleError) {
              recordErroredAttachment(attachment, singleError);
              writeProgress({
                status: "running",
                batchIndex: batchIndex + 1,
                batchCount: batches.length,
                currentFilePath: attachment.filePath,
                processedAttachments:
                  stats.readyAttachments +
                  stats.errorAttachments +
                  stats.missingAttachments +
                  stats.unsupportedAttachments,
                readyAttachments: stats.readyAttachments,
                errorAttachments: stats.errorAttachments,
                missingAttachments: stats.missingAttachments,
                unsupportedAttachments: stats.unsupportedAttachments,
                skippedAttachments: stats.skippedAttachments,
                note: `errored: ${summarizeSyncError(singleError)}`,
              });
            }
          }
          writeProgress({
            status: "running",
            batchIndex: batchIndex + 1,
            batchCount: batches.length,
            processedAttachments:
              stats.readyAttachments +
              stats.errorAttachments +
              stats.missingAttachments +
              stats.unsupportedAttachments,
            readyAttachments: stats.readyAttachments,
            errorAttachments: stats.errorAttachments,
            missingAttachments: stats.missingAttachments,
            unsupportedAttachments: stats.unsupportedAttachments,
            skippedAttachments: stats.skippedAttachments,
            note: "finished individual retries",
          });
          writeProgressCatalog(paths.catalogPath, nextEntries);
          continue;
        }

        recordErroredAttachment(batch[0]!, batchError);
        writeProgress({
          status: "running",
          batchIndex: batchIndex + 1,
          batchCount: batches.length,
          currentFilePath: batch[0]?.filePath,
          processedAttachments:
            stats.readyAttachments +
            stats.errorAttachments +
            stats.missingAttachments +
            stats.unsupportedAttachments,
          readyAttachments: stats.readyAttachments,
          errorAttachments: stats.errorAttachments,
          missingAttachments: stats.missingAttachments,
          unsupportedAttachments: stats.unsupportedAttachments,
          skippedAttachments: stats.skippedAttachments,
          note: `batch failed on single file: ${summarizeSyncError(batchError)}`,
        });
      }
      writeProgress({
        status: "running",
        batchIndex: batchIndex + 1,
        batchCount: batches.length,
        processedAttachments:
          stats.readyAttachments +
          stats.errorAttachments +
          stats.missingAttachments +
          stats.unsupportedAttachments,
        readyAttachments: stats.readyAttachments,
        errorAttachments: stats.errorAttachments,
        missingAttachments: stats.missingAttachments,
        unsupportedAttachments: stats.unsupportedAttachments,
        skippedAttachments: stats.skippedAttachments,
        note: "batch finished",
      });
      writeProgressCatalog(paths.catalogPath, nextEntries);
    }

    for (const docKey of staleDocKeys) {
      exactDeletes.add(docKey);
      stats.removedAttachments += 1;
    }

    nextEntries.sort((a, b) => a.filePath.localeCompare(b.filePath));
    const nextCatalog: CatalogFile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      entries: nextEntries,
    };
    writeProgressCatalog(paths.catalogPath, nextEntries);

    const readyEntries = nextEntries.filter((entry) => entry.extractStatus === "ready");
    const exactIndex = await exactFactory(config);
    try {
      const deleteDocKeys = [...exactDeletes].filter((docKey) => !exactUpserts.has(docKey));
      if (exactIndex.syncExactIndex) {
        logger.info("Updating exact search index...", { console: true });
        await exactIndex.syncExactIndex(readyEntries, {
          upserts: [...exactUpserts.values()],
          deleteDocKeys,
        });
      } else {
        logger.info("Rebuilding exact search index...", { console: true });
        await exactIndex.rebuildExactIndex(readyEntries);
      }
    } finally {
      await exactIndex.close();
    }

    const qmd = await qmdFactory(config);
    try {
      logger.info("Updating search index...", { console: true });
      await qmd.update();
      await syncQmdContexts(qmd, readyEntries);
      if (readyEntries.length > 0) {
        await embedQmdUntilSettled(qmd, logger);
      }
    } finally {
      await qmd.close();
    }

    const finalCounts = summarizeCatalog(nextCatalog);
    stats.readyAttachments = finalCounts.readyAttachments;
    stats.missingAttachments = finalCounts.missingAttachments;
    stats.unsupportedAttachments = finalCounts.unsupportedAttachments;
    stats.errorAttachments = finalCounts.errorAttachments;
    writeProgress({
      status: "completed",
      processedAttachments:
        stats.readyAttachments +
        stats.errorAttachments +
        stats.missingAttachments +
        stats.unsupportedAttachments,
      readyAttachments: stats.readyAttachments,
      errorAttachments: stats.errorAttachments,
      missingAttachments: stats.missingAttachments,
      unsupportedAttachments: stats.unsupportedAttachments,
      skippedAttachments: stats.skippedAttachments,
      note: "sync completed successfully",
    });
    logger.info(`Sync finished. Log saved to ${compactHomePath(logger.logPath)}.`, { console: true });
    removeLifecycleHooks();
    finalizeOnce("ok", fileOutcomes, stats);

    return { stats, config, logPath: logger.logPath };
  } catch (error) {
    removeLifecycleHooks();
    writeProgress({ status: "failed", note: summarizeSyncError(error) });
    logger.error(`Sync aborted: ${summarizeSyncError(error)}`);
    finalizeOnce("failed", activeFileOutcomes, activeStats);
    throw error;
  }
}
