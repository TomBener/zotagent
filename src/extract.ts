// Extraction pipeline: turns attachment files (PDF via OpenDataLoader/Java
// with pdftotext fallbacks, plus epub/html/txt) into published normalized +
// manifest artifact pairs. runSync in sync.ts owns triage, batching, catalog
// bookkeeping, and indexing; this module owns everything from "here is a
// batch of files" to "artifacts are in the store".
import { buildArgs, type ConvertOptions } from "@opendataloader/pdf";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { EmptyArtifactError, type ArtifactStore } from "./artifact-store.js";
import { buildMarkdownManifest, buildPdfManifest } from "./manifest.js";
import { extractEpub } from "./epub.js";
import { extractHtml } from "./html-extract.js";
import type { AttachmentCatalogEntry } from "./types.js";
import { exists, stemForFile } from "./utils.js";

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
  if (error instanceof EmptyArtifactError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return ODL_EMPTY_OUTPUT_PATTERN.test(message);
}

function isOdlTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ODL_TIMEOUT_PATTERN.test(message);
}
const ODL_EXTRA_BATCH_TIMEOUT_MS = 30_000;
const ODL_FORCE_KILL_GRACE_MS = 1_000;
export const ODL_DEFAULT_BATCH_SIZE = 8;
export const ODL_DEFAULT_CONCURRENCY = 2;
const ODL_SINGLE_BATCH_SIZE_BYTES = 20 * 1024 * 1024;

const require = createRequire(import.meta.url);
const ODL_PACKAGE_ENTRY = require.resolve("@opendataloader/pdf");
const ODL_JAR_PATH = resolve(dirname(ODL_PACKAGE_ENTRY), "..", "lib", ODL_JAR_NAME);

export function requireJava(): void {
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

function isLikelyBookAttachment(attachment: AttachmentCatalogEntry): boolean {
  if (attachment.type === "book" || attachment.type === "chapter") return true;
  return attachment.filePath
    .split("/")
    .some((segment) => segment.toLowerCase() === "book");
}

function shouldExtractAttachmentAlone(
  attachment: AttachmentCatalogEntry,
  verticalItemKeys: ReadonlySet<string>,
): boolean {
  if (isLikelyBookAttachment(attachment)) return true;
  if (attachmentIsVertical(attachment, verticalItemKeys)) return true;
  const current = statSync(attachment.filePath, { throwIfNoEntry: false });
  return Boolean(current && current.size >= ODL_SINGLE_BATCH_SIZE_BYTES);
}

function batchUsesVerticalText(
  batch: AttachmentCatalogEntry[],
  verticalItemKeys: ReadonlySet<string>,
): boolean {
  return batch.some((attachment) => attachmentIsVertical(attachment, verticalItemKeys));
}

export function groupForOdlBatches(
  attachments: AttachmentCatalogEntry[],
  verticalItemKeys: ReadonlySet<string>,
  maxBatchSize = ODL_DEFAULT_BATCH_SIZE,
): AttachmentCatalogEntry[][] {
  const out: AttachmentCatalogEntry[][] = [];
  let current: AttachmentCatalogEntry[] = [];
  let stems = new Set<string>();

  for (const attachment of attachments) {
    if (maxBatchSize <= 1 || shouldExtractAttachmentAlone(attachment, verticalItemKeys)) {
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

export type ExtractBatchOptions = {
  timeoutMs?: number;
  verticalItemKeys?: ReadonlySet<string>;
};
// Extractors publish each member through the store as it is built and report
// which docKeys they published. The Set (rather than probing the store) lets
// processBatch catch an extractor that silently skipped a batch member — a
// stale artifact from a previous run must not mask that bug.
export type ExtractBatchFn = (
  batch: AttachmentCatalogEntry[],
  tempRoot: string,
  store: ArtifactStore,
  options?: ExtractBatchOptions,
) => Promise<Set<string>>;

// Internal tier options: extractBatch (the dispatcher and only entry point)
// resolves the vertical-text rule from verticalItemKeys once per call and
// hands the tiers plain data — no tier consults verticalItemKeys itself.
type OdlTierOptions = {
  timeoutMs?: number;
  vertical: boolean;
};

type PdftotextTierOptions = {
  timeoutMs?: number;
  isVertical: (attachment: AttachmentCatalogEntry) => boolean;
};

function attachmentIsVertical(
  attachment: AttachmentCatalogEntry,
  verticalItemKeys: ReadonlySet<string>,
): boolean {
  return attachment.fileExt === "pdf" && verticalItemKeys.has(attachment.itemKey);
}

async function extractBatchPdftotext(
  batch: AttachmentCatalogEntry[],
  tempRoot: string,
  store: ArtifactStore,
  options: PdftotextTierOptions,
): Promise<Set<string>> {
  const tempDir = mkdtempSync(join(tempRoot, "pdftotext-"));
  const published = new Set<string>();

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

      const built = buildMarkdownManifest(
        attachment,
        readFileSync(textPath, "utf-8"),
        options.isVertical(attachment) ? { verticalText: true } : {},
      );
      store.publish(built);
      published.add(attachment.docKey);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  return published;
}

async function extractBatchTextOnly(
  batch: AttachmentCatalogEntry[],
  tempRoot: string,
  store: ArtifactStore,
  options: OdlTierOptions,
): Promise<Set<string>> {
  const tempDir = mkdtempSync(join(tempRoot, "odl-text-"));
  const published = new Set<string>();

  const verticalText = options.vertical;

  try {
    await withJavaToolOptions(() =>
      runOdlConvert(
        batch.map((attachment) => attachment.filePath),
        {
          outputDir: tempDir,
          format: "text",
          ...(verticalText ? { readingOrder: "off" } : {}),
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

      const built = buildMarkdownManifest(
        attachment,
        readFileSync(textPath, "utf-8"),
        verticalText ? { verticalText: true } : {},
      );
      store.publish(built);
      published.add(attachment.docKey);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  return published;
}

export async function extractBatch(
  batch: AttachmentCatalogEntry[],
  tempRoot: string,
  store: ArtifactStore,
  options: ExtractBatchOptions = {},
): Promise<Set<string>> {
  const verticalSet = options.verticalItemKeys ?? new Set<string>();
  const batchVertical = batchUsesVerticalText(batch, verticalSet);
  const timeout = options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {};
  const odlTierOptions: OdlTierOptions = { ...timeout, vertical: batchVertical };

  if (batch.length !== 1) {
    return await extractBatchStructured(batch, tempRoot, store, odlTierOptions);
  }

  let primaryError: unknown;
  try {
    return await extractBatchStructured(batch, tempRoot, store, odlTierOptions);
  } catch (err) {
    primaryError = err;
  }

  const fallbackFailures: Array<{ tier: string; error: unknown }> = [];

  if (isOdlStructuralBug(primaryError)) {
    try {
      return await extractBatchTextOnly(batch, tempRoot, store, odlTierOptions);
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
      return await extractBatchPdftotext(batch, tempRoot, store, {
        ...timeout,
        isVertical: (attachment) => attachmentIsVertical(attachment, verticalSet),
      });
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
  store: ArtifactStore,
  options: OdlTierOptions,
): Promise<Set<string>> {
  const tempDir = mkdtempSync(join(tempRoot, "odl-"));
  const published = new Set<string>();

  const verticalText = options.vertical;

  try {
    await withJavaToolOptions(() =>
      runOdlConvert(
        batch.map((attachment) => attachment.filePath),
        {
          outputDir: tempDir,
          format: "markdown,json",
          ...(verticalText ? { readingOrder: "off" } : {}),
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

      const built = buildPdfManifest(
        attachment,
        readFileSync(markdownPath, "utf-8"),
        readFileSync(jsonPath, "utf-8"),
        verticalText ? { verticalText: true } : {},
      );
      store.publish(built);
      published.add(attachment.docKey);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  return published;
}

export async function extractNonPdfAttachment(
  attachment: AttachmentCatalogEntry,
  store: ArtifactStore,
): Promise<void> {
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

  store.publish(buildMarkdownManifest(attachment, markdown));
}
