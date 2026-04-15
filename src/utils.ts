import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { AttachmentManifest, SupportedFileType } from "./types.js";

export const MANIFEST_EXT = ".json.gz";

export function readManifestFile(path: string): AttachmentManifest {
  const buf = readFileSync(path);
  const json = gunzipSync(buf).toString("utf8");
  return JSON.parse(json) as AttachmentManifest;
}

export function tryReadManifestFile(path: string): AttachmentManifest | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return readManifestFile(path);
  } catch {
    return undefined;
  }
}

export function writeManifestFile(path: string, manifest: AttachmentManifest): void {
  const compact = Buffer.from(JSON.stringify(manifest), "utf8");
  const gz = gzipSync(compact, { level: 9 });
  const tmp = path + ".tmp";
  writeFileSync(tmp, gz);
  renameSync(tmp, path);
}

export function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

export function resolveHomePath(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return resolve(homedir(), raw.slice(2));
  return raw;
}

export function normalizePathForLookup(input: string): string {
  let out = resolveHomePath(input.trim())
    .normalize("NFC")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
  if (out.startsWith("/private/")) {
    out = out.slice("/private".length);
  }
  return out;
}

export function compactHomePath(raw: string): string {
  const normalized = normalizePathForLookup(raw);
  const home = normalizePathForLookup(homedir());
  if (normalized === home) return "~";
  if (normalized.startsWith(`${home}/`)) {
    return `~${normalized.slice(home.length)}`;
  }
  return normalized;
}

export function ensureDir(path: string): void {
  mkdirSync(resolveHomePath(path), { recursive: true });
}

export function ensureParentDir(path: string): void {
  ensureDir(dirname(path));
}

export function cleanText(input: string): string {
  return input
    .replace(/\r/g, "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export function exists(path: string): boolean {
  return existsSync(resolveHomePath(path));
}

export function formatAuthors(authors: string[]): string {
  return authors.join("; ");
}

export function toSupportedFileType(filePath: string): SupportedFileType {
  if (/\.pdf$/i.test(filePath)) return "pdf";
  if (/\.epub$/i.test(filePath)) return "epub";
  if (/\.html?$/i.test(filePath)) return "html";
  if (/\.txt$/i.test(filePath)) return "txt";
  return "other";
}

export function stemForFile(filePath: string): string {
  return basename(filePath).replace(/\.[^.]+$/u, "");
}

export function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}
