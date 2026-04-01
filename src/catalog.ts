import { existsSync, readFileSync } from "node:fs";

import type { AppConfig, AttachmentCatalogEntry, BibliographyRecord } from "./types.js";
import { formatAuthors, normalizePathForLookup, sha1, toSupportedFileType } from "./utils.js";

interface RawBibliographyAuthor {
  family?: string;
  given?: string;
  literal?: string;
}

interface RawBibliographyItem {
  id?: string;
  title?: string;
  author?: RawBibliographyAuthor[];
  editor?: RawBibliographyAuthor[];
  issued?: {
    "date-parts"?: unknown[];
  };
  abstract?: string;
  type?: string;
  file?: string;
  "zotero-item-key"?: string;
}

export interface CatalogData {
  records: BibliographyRecord[];
  attachments: AttachmentCatalogEntry[];
}

function readBibliography(path: string): RawBibliographyItem[] {
  if (!existsSync(path)) {
    throw new Error(`Bibliography JSON not found: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (Array.isArray(parsed)) return parsed as RawBibliographyItem[];
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.items)) return record.items as RawBibliographyItem[];
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) return value as RawBibliographyItem[];
    }
  }
  return [];
}

function parsePeople(people?: RawBibliographyAuthor[]): string[] {
  if (!Array.isArray(people)) return [];
  return people
    .map((person) => {
      if (typeof person.literal === "string" && person.literal.trim()) {
        return person.literal.trim();
      }
      const family = (person.family || "").trim();
      const given = (person.given || "").trim();
      if (family && given) return `${family} ${given}`;
      return family || given || "";
    })
    .filter((name) => name.length > 0);
}

function extractYear(issued?: { "date-parts"?: unknown[] }): string | undefined {
  const first = issued?.["date-parts"]?.[0];
  if (!Array.isArray(first) || first.length === 0) return undefined;
  const value = first[0];
  return typeof value === "number" || typeof value === "string" ? String(value) : undefined;
}

function splitFileField(file: string | undefined): string[] {
  const raw = (file || "").trim();
  if (!raw) return [];
  return raw
    .split(";")
    .map((part) => normalizePathForLookup(part))
    .filter((part) => part.length > 0);
}

export function loadCatalog(config: AppConfig): CatalogData {
  const rawItems = readBibliography(config.bibliographyJsonPath);
  const records: BibliographyRecord[] = [];
  const attachments: AttachmentCatalogEntry[] = [];
  const normalizedRoot = normalizePathForLookup(config.attachmentsRoot);

  for (const item of rawItems) {
    const itemKey = (item["zotero-item-key"] || "").trim();
    if (!itemKey) continue;

    const authors = parsePeople(item.author);
    const editors = authors.length > 0 ? [] : parsePeople(item.editor);
    const people = authors.length > 0 ? authors : editors;
    const title = (item.title || "").trim() || itemKey;
    const attachmentPaths = splitFileField(item.file).filter((filePath) =>
      filePath.startsWith(normalizedRoot),
    );

    records.push({
      itemKey,
      citationKey: (item.id || "").trim() || undefined,
      title,
      authors: people,
      year: extractYear(item.issued),
      abstract: (item.abstract || "").trim() || undefined,
      type: (item.type || "").trim() || undefined,
      attachmentPaths,
    });

    for (const filePath of attachmentPaths) {
      const fileExt = toSupportedFileType(filePath);
      attachments.push({
        docKey: sha1(filePath),
        itemKey,
        citationKey: (item.id || "").trim() || undefined,
        title,
        authors: people,
        year: extractYear(item.issued),
        abstract: (item.abstract || "").trim() || undefined,
        type: (item.type || "").trim() || undefined,
        filePath,
        fileExt,
        exists: existsSync(filePath),
        supported: fileExt === "pdf",
      });
    }
  }

  attachments.sort((a, b) => a.filePath.localeCompare(b.filePath));
  records.sort((a, b) => a.itemKey.localeCompare(b.itemKey));
  return { records, attachments };
}

export function authorsToText(authors: string[]): string {
  return formatAuthors(authors);
}
