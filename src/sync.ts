import { buildArgs, type ConvertOptions } from "@opendataloader/pdf";
import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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
import { KEYWORD_INDEX_SCHEMA_VERSION, openKeywordIndex, type KeywordIndexFactory } from "./keyword-db.js";
import { QMD_PACKAGE_VERSION, openQmdClient, resolveQmdEmbedModel, type QmdFactory } from "./qmd.js";
import { mapEntriesByDocKey, readCatalogFile, summarizeCatalog, writeCatalogFile } from "./state.js";
import type { AttachmentCatalogEntry, AttachmentManifest, CatalogEntry, CatalogFile, SyncStats } from "./types.js";
import {
  MANIFEST_EXT,
  compactHomePath,
  ensureDir,
  ensureParentDir,
  exists,
  stemForFile,
  tryReadManifestFile,
  writeManifestFile,
} from "./utils.js";

const HIDE_JAVA_DOCK_ICON_FLAG = "-Dapple.awt.UIElement=true";
const JVM_STACK_SIZE_FLAG = "-Xss32m";
const ODL_JAR_NAME = "opendataloader-pdf-cli.jar";
const ODL_SINGLE_PDF_TIMEOUT_MS = 600_000;
const ODL_STRUCTURAL_BUG_PATTERNS = [
  /StackOverflowError/i,
  /HeadingProcessor/i,
  /LevelProcessor/i,
  /Comparison method violates/i,
  /outside raster/i,
];
const ODL_EMPTY_OUTPUT_PATTERN = /Extracted output was empty/i;
const ODL_TIMEOUT_PATTERN = /timed out after/i;

function isOdlStructuralBug(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ODL_STRUCTURAL_BUG_PATTERNS.some((pattern) => pattern.test(message));
}

function isOdlEmptyOutput(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ODL_EMPTY_OUTPUT_PATTERN.test(message);
}

function isOdlTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ODL_TIMEOUT_PATTERN.test(message);
}
const ODL_EXTRA_BATCH_TIMEOUT_MS = 30_000;
const ODL_FORCE_KILL_GRACE_MS = 1_000;
const ODL_DEFAULT_BATCH_SIZE = 8;
const ODL_SINGLE_BATCH_SIZE_BYTES = 20 * 1024 * 1024;

const require = createRequire(import.meta.url);
const PACKAGE_JSON = require("../package.json") as { version?: string };
const ZOTAGENT_PACKAGE_VERSION =
  typeof PACKAGE_JSON.version === "string" && PACKAGE_JSON.version.length > 0 ? PACKAGE_JSON.version : "unknown";
const ODL_PACKAGE_ENTRY = require.resolve("@opendataloader/pdf");
const ODL_JAR_PATH = resolve(dirname(ODL_PACKAGE_ENTRY), "..", "lib", ODL_JAR_NAME);
const SYNC_INDEXER_VERSION = "sync-index-v1";

export function buildIndexerSignature(qmdEmbedModel: string): string {
  return createHash("sha1")
    .update(
      [
        `zotagent=${ZOTAGENT_PACKAGE_VERSION}`,
        `syncIndexer=${SYNC_INDEXER_VERSION}`,
        `keywordSchema=${KEYWORD_INDEX_SCHEMA_VERSION}`,
        `qmdPackage=${QMD_PACKAGE_VERSION}`,
        `qmdEmbedModel=${qmdEmbedModel}`,
      ].join("\n"),
    )
    .digest("hex");
}

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
    paths: ReturnType<typeof getDataPaths>,
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

export function buildJavaToolOptions(
  existing: string | undefined,
  options: { hideDockIcon: boolean },
): string {
  const flags: string[] = [JVM_STACK_SIZE_FLAG];
  if (options.hideDockIcon) {
    flags.push(HIDE_JAVA_DOCK_ICON_FLAG);
  }
  const base = existing && existing.trim().length > 0 ? existing : "";
  const parts = base.length > 0 ? [base] : [];
  for (const flag of flags) {
    if (!parts.some((part) => part.includes(flag))) {
      parts.push(flag);
    }
  }
  return parts.join(" ");
}

export async function withJavaToolOptions<T>(
  task: () => Promise<T>,
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<T> {
  const env = options.env ?? process.env;
  const previous = env.JAVA_TOOL_OPTIONS;
  env.JAVA_TOOL_OPTIONS = buildJavaToolOptions(previous, {
    hideDockIcon: shouldHideJavaDockIcon(options.platform, env),
  });

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

function areAuthorsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Fields compared feed directly into the keyword index (title + manifest
// content, gated by file size/mtime/sourceHash) or into qmd contexts
// (title/authors/year/abstract). If any differ, we cannot reuse the prior
// index state.
export function isEntryContentUnchanged(prev: CatalogEntry, next: CatalogEntry): boolean {
  return (
    prev.extractStatus === next.extractStatus &&
    prev.itemKey === next.itemKey &&
    prev.citationKey === next.citationKey &&
    prev.title === next.title &&
    prev.year === next.year &&
    prev.abstract === next.abstract &&
    prev.type === next.type &&
    prev.filePath === next.filePath &&
    prev.size === next.size &&
    prev.mtimeMs === next.mtimeMs &&
    prev.sourceHash === next.sourceHash &&
    prev.normalizedPath === next.normalizedPath &&
    prev.manifestPath === next.manifestPath &&
    areAuthorsEqual(prev.authors, next.authors)
  );
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

function readReusableArtifactManifest(
  identity: Pick<AttachmentCatalogEntry, "docKey" | "itemKey">,
  normalizedPath: string | undefined,
  manifestPath: string | undefined,
): AttachmentManifest | undefined {
  if (!normalizedPath || !manifestPath) return undefined;
  if (!exists(normalizedPath) || !exists(manifestPath)) return undefined;
  if (!hasReusableNormalizedOutput(normalizedPath)) return undefined;

  const manifest = tryReadManifestFile(manifestPath);
  if (!manifest) return undefined;
  if (manifest.blocks.length === 0) return undefined;

  return manifest.docKey === identity.docKey && manifest.itemKey === identity.itemKey
    ? manifest
    : undefined;
}

function hasReusableArtifacts(
  attachment: AttachmentCatalogEntry,
  normalizedPath: string | undefined,
  manifestPath: string | undefined,
): normalizedPath is string {
  return readReusableArtifactManifest(attachment, normalizedPath, manifestPath) !== undefined;
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

async function extractBatchPdftotext(
  batch: AttachmentCatalogEntry[],
  tempRoot: string,
  manifestsDir: string,
  normalizedDir: string,
  options: ExtractBatchOptions = {},
): Promise<Map<string, ExtractedPaths>> {
  const tempDir = mkdtempSync(join(tempRoot, "pdftotext-"));
  const byDocKey = new Map<string, ExtractedPaths>();

  try {
    for (const attachment of batch) {
      const textPath = join(tempDir, `${attachment.docKey}.txt`);
      await runProcessWithTimeout({
        command: "pdftotext",
        args: ["-layout", attachment.filePath, textPath],
        timeoutMs: options.timeoutMs ?? ODL_SINGLE_PDF_TIMEOUT_MS,
        label: "pdftotext extraction",
      });

      if (!exists(textPath)) {
        throw new Error(`pdftotext output not found for ${attachment.filePath}`);
      }

      const normalizedPath = resolve(normalizedDir, `${attachment.docKey}.md`);
      const manifestPath = resolve(manifestsDir, `${attachment.docKey}${MANIFEST_EXT}`);
      ensureParentDir(normalizedPath);
      ensureParentDir(manifestPath);

      const built = buildMarkdownManifest(
        attachment,
        readFileSync(textPath, "utf-8"),
        normalizedPath,
      );
      assertNonEmptyExtractedOutput(attachment.filePath, built);

      writeFileSync(normalizedPath, built.markdown, "utf-8");
      writeManifestFile(manifestPath, built.manifest);
      byDocKey.set(attachment.docKey, { manifestPath, normalizedPath });
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  return byDocKey;
}

async function extractBatchTextOnly(
  batch: AttachmentCatalogEntry[],
  tempRoot: string,
  manifestsDir: string,
  normalizedDir: string,
  options: ExtractBatchOptions = {},
): Promise<Map<string, ExtractedPaths>> {
  const tempDir = mkdtempSync(join(tempRoot, "odl-text-"));
  const byDocKey = new Map<string, ExtractedPaths>();

  try {
    await withJavaToolOptions(() =>
      runOdlConvert(
        batch.map((attachment) => attachment.filePath),
        {
          outputDir: tempDir,
          format: "text",
        },
        options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
      ),
    );

    for (const attachment of batch) {
      const stem = stemForFile(attachment.filePath);
      const textPath = resolve(tempDir, `${stem}.txt`);
      if (!exists(textPath)) {
        throw new Error(`OpenDataLoader text output not found for ${attachment.filePath}`);
      }

      const normalizedPath = resolve(normalizedDir, `${attachment.docKey}.md`);
      const manifestPath = resolve(manifestsDir, `${attachment.docKey}${MANIFEST_EXT}`);
      ensureParentDir(normalizedPath);
      ensureParentDir(manifestPath);

      const built = buildMarkdownManifest(
        attachment,
        readFileSync(textPath, "utf-8"),
        normalizedPath,
      );
      assertNonEmptyExtractedOutput(attachment.filePath, built);

      writeFileSync(normalizedPath, built.markdown, "utf-8");
      writeManifestFile(manifestPath, built.manifest);
      byDocKey.set(attachment.docKey, { manifestPath, normalizedPath });
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  return byDocKey;
}

async function extractBatch(
  batch: AttachmentCatalogEntry[],
  tempRoot: string,
  manifestsDir: string,
  normalizedDir: string,
  options: ExtractBatchOptions = {},
): Promise<Map<string, ExtractedPaths>> {
  if (batch.length !== 1) {
    return await extractBatchStructured(batch, tempRoot, manifestsDir, normalizedDir, options);
  }

  let primaryError: unknown;
  try {
    return await extractBatchStructured(batch, tempRoot, manifestsDir, normalizedDir, options);
  } catch (err) {
    primaryError = err;
  }

  const fallbackFailures: Array<{ tier: string; error: unknown }> = [];

  if (isOdlStructuralBug(primaryError)) {
    try {
      return await extractBatchTextOnly(batch, tempRoot, manifestsDir, normalizedDir, options);
    } catch (err) {
      fallbackFailures.push({ tier: "odl-text", error: err });
    }
  }

  if (
    isOdlStructuralBug(primaryError) ||
    isOdlEmptyOutput(primaryError) ||
    isOdlTimeout(primaryError)
  ) {
    try {
      return await extractBatchPdftotext(batch, tempRoot, manifestsDir, normalizedDir, options);
    } catch (err) {
      fallbackFailures.push({ tier: "pdftotext", error: err });
    }
  }

  throw annotateWithFallbackFailures(primaryError, fallbackFailures);
}

export function annotateWithFallbackFailures(
  primaryError: unknown,
  failures: Array<{ tier: string; error: unknown }>,
): unknown {
  if (failures.length === 0 || !(primaryError instanceof Error)) return primaryError;
  const suffix = failures
    .map(({ tier, error }) => {
      const message = error instanceof Error ? error.message : String(error);
      return `${tier}: ${message.split("\n")[0]?.trim() ?? message}`;
    })
    .join("; ");
  primaryError.message = `${primaryError.message} (fallbacks also failed: ${suffix})`;
  return primaryError;
}

async function extractBatchStructured(
  batch: AttachmentCatalogEntry[],
  tempRoot: string,
  manifestsDir: string,
  normalizedDir: string,
  options: ExtractBatchOptions = {},
): Promise<Map<string, ExtractedPaths>> {
  const tempDir = mkdtempSync(join(tempRoot, "odl-"));
  const byDocKey = new Map<string, ExtractedPaths>();

  try {
    await withJavaToolOptions(() =>
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
      const manifestPath = resolve(manifestsDir, `${attachment.docKey}${MANIFEST_EXT}`);
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
      writeManifestFile(manifestPath, built.manifest);
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
  const manifestPath = resolve(manifestsDir, `${attachment.docKey}${MANIFEST_EXT}`);
  ensureParentDir(normalizedPath);
  ensureParentDir(manifestPath);

  const built = buildMarkdownManifest(attachment, markdown, normalizedPath);
  assertNonEmptyExtractedOutput(attachment.filePath, built);
  writeFileSync(normalizedPath, built.markdown, "utf-8");
  writeManifestFile(manifestPath, built.manifest);

  return { manifestPath, normalizedPath };
}

export function buildContext(entry: CatalogEntry): string {
  const parts = [
    entry.title,
    entry.authors.length > 0 ? entry.authors.join(", ") : undefined,
    entry.year,
    entry.abstract,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return parts.join("\n");
}

type IndexerState = {
  indexedQmdEmbedModel: string;
  indexerSignature: string;
};

function writeProgressCatalog(
  path: string,
  entries: CatalogEntry[],
  indexerState?: IndexerState,
): void {
  // Persist the active embed model and indexer signature on progress writes
  // when they are known to match the qmd DB. During a model/signature change,
  // callers keep the old state here until old vectors have been cleared.
  // `indexesCompletedAt` is deliberately omitted: the short-circuit path still
  // requires it, so a mid-flight write cannot be mistaken for a completed sync.
  const snapshot: CatalogFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [...entries].sort((a, b) => a.filePath.localeCompare(b.filePath)),
    ...(indexerState
      ? {
          indexedQmdEmbedModel: indexerState.indexedQmdEmbedModel,
          indexerSignature: indexerState.indexerSignature,
        }
      : {}),
  };
  writeCatalogFile(path, snapshot);
}

async function syncQmdContexts(qmd: Awaited<ReturnType<QmdFactory>>, readyEntries: CatalogEntry[]): Promise<void> {
  const existingContexts = new Map<string, string>();
  for (const row of await qmd.listContexts()) {
    if (row.collection === "library") {
      existingContexts.set(row.path, row.context);
    }
  }

  const desired = new Map<string, string>();
  for (const entry of readyEntries) {
    desired.set(`/${entry.docKey}.md`, buildContext(entry));
  }

  for (const path of existingContexts.keys()) {
    if (!desired.has(path)) {
      await qmd.removeContext("library", path);
    }
  }

  for (const [path, contextText] of desired) {
    if (existingContexts.get(path) === contextText) continue;
    await qmd.addContext("library", path, contextText);
  }
}

async function embedQmdUntilSettled(
  qmd: Awaited<ReturnType<QmdFactory>>,
  logger: SyncLogger,
  options: { force?: boolean } = {},
): Promise<void> {
  let pass = 0;
  let forceNextPass = options.force ?? false;

  while (true) {
    const before = await qmd.getStatus();
    if (before.needsEmbedding <= 0 && !forceNextPass) return;

    pass += 1;
    const forceThisPass = forceNextPass;
    forceNextPass = false;
    logger.info(
      forceThisPass
        ? "Regenerating embeddings after qmd embedding model change."
        : pass === 1
          ? `Generating embeddings for ${before.needsEmbedding} document(s).`
          : `Continuing embeddings (pass ${pass}, ${before.needsEmbedding} document(s) remaining).`,
      { console: true },
    );

    await qmd.embed(forceThisPass ? { force: true } : undefined);

    const after = await qmd.getStatus();
    if (after.needsEmbedding <= 0) {
      if (pass > 1) {
        logger.info(`Embedding complete after ${pass} pass(es).`, { console: true });
      }
      return;
    }

    if (forceThisPass) {
      logger.info(
        `Forced embedding pass finished; ${after.needsEmbedding} document(s) still need embeddings.`,
        { console: true },
      );
      continue;
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
  keywordFactory: KeywordIndexFactory = openKeywordIndex,
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
    // Paths the current bibliography still references. Used twice below:
    // (a) building the rename-detection index, so we only treat an entry as
    //     the "old side" of a rename when its filePath has actually dropped
    //     out of the bibliography — otherwise it is still live;
    // (b) deciding whether to prune caches for deduplicated attachments.
    const bibliographyReferencedPaths = new Set(
      catalogData.records.flatMap((record) => record.attachmentPaths),
    );
    // Rename index: map (itemKey,size,mtimeMs) → previous ready entry whose
    // filePath is no longer in the bibliography. An attachment that renames a
    // PDF inside attachmentsRoot changes relativePath (and therefore
    // docKey = sha1(relativePath)) without changing size or mtime; matching
    // on that triple lets us migrate the cached artifacts to the new docKey
    // instead of re-extracting and re-embedding identical content.
    const renameCandidateIndex = new Map<string, CatalogEntry | null>();
    for (const prev of previousCatalog.entries) {
      if (prev.extractStatus !== "ready") continue;
      if (prev.size === null || prev.mtimeMs === null) continue;
      if (bibliographyReferencedPaths.has(prev.filePath)) continue;
      const key = `${prev.itemKey}\u0000${prev.size}\u0000${prev.mtimeMs}`;
      if (renameCandidateIndex.has(key)) {
        renameCandidateIndex.set(key, null);
      } else {
        renameCandidateIndex.set(key, prev);
      }
    }
    const currentQmdEmbedModel = resolveQmdEmbedModel(config);
    const currentIndexerSignature = buildIndexerSignature(currentQmdEmbedModel);
    const currentIndexerState: IndexerState = {
      indexedQmdEmbedModel: currentQmdEmbedModel,
      indexerSignature: currentIndexerSignature,
    };
    const previousIndexerState: IndexerState | undefined =
      previousCatalog.indexedQmdEmbedModel && previousCatalog.indexerSignature
        ? {
            indexedQmdEmbedModel: previousCatalog.indexedQmdEmbedModel,
            indexerSignature: previousCatalog.indexerSignature,
          }
        : undefined;
    const qmdEmbedModelChanged = previousCatalog.indexedQmdEmbedModel !== currentQmdEmbedModel;
    const indexerSignatureChanged = previousCatalog.indexerSignature !== currentIndexerSignature;
    const qmdIndexerStateChanged = qmdEmbedModelChanged || indexerSignatureChanged;
    const previousHadReadyEntries = previousCatalog.entries.some(
      (entry) => entry.extractStatus === "ready",
    );
    const qmdMayContainExistingEmbeddings =
      previousHadReadyEntries || previousIndexerState !== undefined;
    let progressIndexerState: IndexerState | undefined =
      qmdIndexerStateChanged && qmdMayContainExistingEmbeddings
        ? previousIndexerState
        : currentIndexerState;
    const nextEntries: CatalogEntry[] = [];
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
      const fallbackManifestPath = resolve(paths.manifestsDir, `${attachment.docKey}${MANIFEST_EXT}`);
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

      // Rename fast path: an attachment we have never seen under this docKey,
      // with no fallback artifacts locally, may be the same PDF renamed or
      // moved inside attachmentsRoot. If (itemKey,size,mtimeMs) matches a
      // previous ready entry whose filePath has dropped out of the
      // bibliography, migrate the cached normalized+manifest from the old
      // docKey to the new one instead of re-extracting and re-embedding.
      if (previous === undefined && !fallbackArtifactsReusable) {
        const renameKey = `${attachment.itemKey}\u0000${current.size}\u0000${currentMtimeMs}`;
        const renameFromPrev = renameCandidateIndex.get(renameKey);
        const renameFromNormalizedPath =
          renameFromPrev !== undefined && renameFromPrev !== null
            ? renameFromPrev.normalizedPath
            : undefined;
        const renameFromManifestPath =
          renameFromPrev !== undefined && renameFromPrev !== null
            ? renameFromPrev.manifestPath
            : undefined;
        const oldManifest =
          renameFromPrev === undefined || renameFromPrev === null
            ? undefined
            : readReusableArtifactManifest(
                renameFromPrev,
                renameFromNormalizedPath,
                renameFromManifestPath,
              );
        if (
          renameFromPrev !== undefined &&
          renameFromPrev !== null &&
          oldManifest &&
          renameFromNormalizedPath &&
          renameFromManifestPath
        ) {
          try {
            renameSync(renameFromNormalizedPath, fallbackNormalizedPath);
            try {
              renameSync(renameFromManifestPath, fallbackManifestPath);
            } catch (manifestErr) {
              // Roll back the normalized rename so we never end up with a
              // half-migrated pair on disk.
              try {
                renameSync(fallbackNormalizedPath, renameFromNormalizedPath);
              } catch {
                // best effort — original callsite will still throw
              }
              throw manifestErr;
            }
            // Rewrite manifest so its stored docKey/filePath/normalizedPath
            // match the new identity. hasReusableArtifacts checks docKey on
            // the next run and would otherwise force a re-extract.
            writeManifestFile(fallbackManifestPath, {
              docKey: attachment.docKey,
              itemKey: attachment.itemKey,
              ...(attachment.citationKey ? { citationKey: attachment.citationKey } : {}),
              title: attachment.title,
              authors: attachment.authors,
              ...(attachment.year ? { year: attachment.year } : {}),
              ...(attachment.abstract ? { abstract: attachment.abstract } : {}),
              filePath: attachment.filePath,
              normalizedPath: fallbackNormalizedPath,
              blocks: oldManifest.blocks,
            });
            nextEntries.push(
              toCatalogEntry(attachment, {
                extractStatus: "ready",
                size: current.size,
                mtimeMs: currentMtimeMs,
                sourceHash: renameFromPrev.sourceHash ?? null,
                lastIndexedAt: renameFromPrev.lastIndexedAt ?? null,
                normalizedPath: fallbackNormalizedPath,
                manifestPath: fallbackManifestPath,
              }),
            );
            fileOutcomes.push({
              kind: "skipped",
              filePath: attachment.filePath,
              detail: `migrated artifacts from renamed attachment (was ${compactHomePath(renameFromPrev.filePath)})`,
            });
            stats.readyAttachments += 1;
            stats.skippedAttachments += 1;
            staleDocKeys.delete(renameFromPrev.docKey);
            renameCandidateIndex.delete(renameKey);
            continue;
          } catch (err) {
            logger.warn(
              `Rename migration failed for ${compactHomePath(attachment.filePath)}; falling back to re-extract: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
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
      writeProgressCatalog(paths.catalogPath, nextEntries, progressIndexerState);
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
      stats.readyAttachments += 1;
      stats.updatedAttachments += 1;
      stats.indexedAttachments += 1;
    }

    function recordErroredAttachment(attachment: AttachmentCatalogEntry, error: unknown): void {
      const previous = previousByDocKey.get(attachment.docKey);
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
          writeProgressCatalog(paths.catalogPath, nextEntries, progressIndexerState);
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
      writeProgressCatalog(paths.catalogPath, nextEntries, progressIndexerState);
    }

    for (const docKey of staleDocKeys) {
      stats.removedAttachments += 1;
      const previous = previousByDocKey.get(docKey);
      // Only prune cached artifacts for deliberately-deduplicated attachments
      // (the file is still referenced by the bibliography, just filtered from
      // the indexer queue). Attachments that simply disappeared from disk or
      // from Zotero keep their cache so a future sync can resume without
      // re-extracting.
      if (!previous || !bibliographyReferencedPaths.has(previous.filePath)) continue;
      const manifestPath = resolve(paths.manifestsDir, `${docKey}${MANIFEST_EXT}`);
      const normalizedPath = resolve(paths.normalizedDir, `${docKey}.md`);
      for (const p of [manifestPath, normalizedPath]) {
        if (exists(p)) {
          try {
            unlinkSync(p);
          } catch {
            // tolerate races / permission issues
          }
        }
      }
    }

    nextEntries.sort((a, b) => a.filePath.localeCompare(b.filePath));
    const nextCatalog: CatalogFile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      entries: nextEntries,
    };
    writeProgressCatalog(paths.catalogPath, nextEntries, progressIndexerState);

    const readyEntries = nextEntries.filter((entry) => entry.extractStatus === "ready");
    const qmdResetNeeded = qmdIndexerStateChanged && qmdMayContainExistingEmbeddings;

    // Short-circuit: when nothing has changed since the last *completed* sync,
    // both index rebuild passes are provably no-ops. `indexesCompletedAt` is
    // only present if the previous run reached the end of the qmd block, so a
    // crash between the progress-catalog write and qmd completion does not
    // incorrectly trigger this path. Also require indexer state to match:
    // changing the qmd model, qmd package, keyword schema, or zotagent indexer
    // version invalidates stored index data.
    const allEntriesUnchanged =
      previousCatalog.indexesCompletedAt !== undefined &&
      !qmdEmbedModelChanged &&
      !indexerSignatureChanged &&
      changedAttachments.length === 0 &&
      staleDocKeys.size === 0 &&
      nextEntries.every((entry) => {
        const prev = previousByDocKey.get(entry.docKey);
        return prev !== undefined && isEntryContentUnchanged(prev, entry);
      });

    if (allEntriesUnchanged) {
      logger.info(
        "No catalog changes since last completed sync; keyword and semantic indexes are up to date.",
        { console: true },
      );
    } else {
      const keywordIndex = await keywordFactory(config);
      try {
        logger.info("Rebuilding keyword search index...", { console: true });
        await keywordIndex.rebuildIndex(readyEntries);
      } finally {
        await keywordIndex.close();
      }

      const qmd = await qmdFactory(config);
      try {
        logger.info("Updating search index...", { console: true });
        await qmd.update();
        await syncQmdContexts(qmd, readyEntries);
        if (qmdResetNeeded) {
          logger.info("Clearing existing qmd embeddings after indexer state change.", {
            console: true,
          });
          await qmd.clearEmbeddings();
          progressIndexerState = currentIndexerState;
          writeProgressCatalog(paths.catalogPath, nextEntries, progressIndexerState);
        }
        if (readyEntries.length > 0) {
          await embedQmdUntilSettled(qmd, logger);
        }
        // Reap the tombstones and stray vectors qmd.update leaves behind.
        // Without this every removed or content-changed doc leaks vector
        // rows; `deleteInactiveDocuments` must run before the two cleanup
        // calls so the content/vector "referenced by active docs" filter
        // no longer shields rows held by active=0 tombstones.
        const cleanup = await qmd.cleanupOrphans();
        const totalCleaned =
          cleanup.deletedInactiveDocuments +
          cleanup.cleanedOrphanedContent +
          cleanup.cleanedOrphanedVectors;
        if (totalCleaned > 0) {
          logger.info(
            `Cleaned qmd residue: ${cleanup.deletedInactiveDocuments} inactive doc(s), ${cleanup.cleanedOrphanedContent} content row(s), ${cleanup.cleanedOrphanedVectors} vector(s).`,
            { console: true },
          );
        }
      } finally {
        await qmd.close();
      }
    }

    // Persist the completion marker so the next run can safely short-circuit.
    const completionTimestamp = new Date().toISOString();
    writeCatalogFile(paths.catalogPath, {
      ...nextCatalog,
      generatedAt: completionTimestamp,
      indexesCompletedAt: completionTimestamp,
      indexedQmdEmbedModel: currentQmdEmbedModel,
      indexerSignature: currentIndexerSignature,
    });

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
