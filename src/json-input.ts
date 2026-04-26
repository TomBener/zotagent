import { readFile } from "node:fs/promises";
import { text as readStreamText } from "node:stream/consumers";

import { cleanDoi, mapManualAuthors } from "./add.js";

export interface AddJsonInput {
  itemType: string;
  title: string;
  /**
   * Already-Zotero-shaped fields ready to merge into the template payload.
   * Keys not present on the resolved Zotero template are dropped silently
   * by the consumer (template-gating), matching the manual / DOI paths.
   * `publicationTitle` is special-cased by the consumer: it routes through
   * applyPublicationField so book / proceedings / website item types pick
   * the right container field.
   */
  fields: Record<string, unknown>;
  /** Per-item collection routing. CLI --collection-key still wins if set. */
  collections?: string[];
  /**
   * Per-item linked-file attachment path. Consumer validates the path and
   * creates a `linkMode: linked_file` child item under the parent. Bad paths
   * abort the item before the parent is created (no orphans in Zotero).
   */
  attachFile?: string;
  /** Surfaced into AddResult.warnings for the corresponding item. */
  warnings: string[];
}

export interface JsonInputBundle {
  /** One raw JSON object per item, always wrapped in an array. */
  items: unknown[];
  origin: "file" | "stdin";
  /** True when the top-level JSON was an array, false for a single object. */
  wasArray: boolean;
}

const RESERVED_INPUT_KEYS = new Set([
  "itemType",
  "title",
  "creators",
  "authors",
  "tags",
  "keywords",
  "abstractNote",
  "abstract",
  "DOI",
  "doi",
  "publicationTitle",
  "publication",
  "journal",
  "accessDate",
  "access-date",
  "accessedAt",
  "collections",
  "collectionKey",
  "date",
  "year",
  "attachFile",
  "attach-file",
]);

class JsonInputError extends Error {
  details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "JsonInputError";
    if (details !== undefined) this.details = details;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(raw: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function normalizeTags(raw: unknown): { tags: { tag: string }[]; dropped: number } {
  if (!Array.isArray(raw)) return { tags: [], dropped: 0 };
  const tags: { tag: string }[] = [];
  let dropped = 0;
  for (const entry of raw) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed) tags.push({ tag: trimmed });
      else dropped++;
    } else if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { tag?: unknown }).tag === "string"
    ) {
      // Pass through {tag, type?} objects unchanged.
      tags.push(entry as { tag: string });
    } else {
      dropped++;
    }
  }
  return { tags, dropped };
}

function normalizeKeywordsToTags(raw: unknown): { tags: { tag: string }[]; dropped: number } {
  if (!Array.isArray(raw)) return { tags: [], dropped: 0 };
  const tags: { tag: string }[] = [];
  let dropped = 0;
  for (const entry of raw) {
    if (typeof entry !== "string") {
      dropped++;
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed) tags.push({ tag: trimmed });
    else dropped++;
  }
  return { tags, dropped };
}

/**
 * Map a single raw JSON object (lenient input) to the strict shape the
 * downstream consumer (`addJsonItemsToZotero`) expects. Field aliases:
 *
 *   creators (preferred) | authors[]   → creators[]   (authors strings via parseAuthorName)
 *   tags     (preferred) | keywords[]  → tags[]       (string entries wrapped to {tag})
 *   abstractNote         | abstract    → abstractNote
 *   DOI                  | doi         → DOI          (run through cleanDoi; invalid → dropped+warn)
 *   publicationTitle | publication | journal → publicationTitle (re-routed to the right
 *                                              container field by applyPublicationField)
 *   accessDate | access-date | accessedAt → accessDate
 *   date | year                        → date         (Zotero stores publication date in `date`,
 *                                                       not `year`)
 *   collections (string|string[]) | collectionKey → collections[]
 *
 * Any other key passes through to `fields` unchanged. Template-gating in the
 * consumer drops keys that the resolved Zotero item template doesn't expose.
 */
export function mapLenientItem(raw: unknown): AddJsonInput {
  if (!isPlainObject(raw)) {
    throw new JsonInputError("Each --json item must be a JSON object.", { received: raw });
  }

  const warnings: string[] = [];
  const fields: Record<string, unknown> = {};

  const title = pickString(raw, ["title"]);
  if (!title) {
    throw new JsonInputError("Each --json item must include a non-empty 'title'.");
  }

  const itemType = pickString(raw, ["itemType"]) || "journalArticle";

  // Creators (preferred) vs authors[] (alias)
  if (Array.isArray(raw.creators) && raw.creators.length > 0) {
    fields.creators = raw.creators;
    if (Array.isArray(raw.authors) && raw.authors.length > 0) {
      warnings.push("Both 'creators' and 'authors' provided; using 'creators' and ignoring 'authors'.");
    }
  } else if (Array.isArray(raw.authors) && raw.authors.length > 0) {
    const stringAuthors = raw.authors.filter((entry): entry is string => typeof entry === "string");
    if (stringAuthors.length < raw.authors.length) {
      warnings.push("'authors' contained non-string entries; only string authors were used.");
    }
    const creators = mapManualAuthors(stringAuthors);
    if (creators.length > 0) fields.creators = creators;
  }

  // Tags (preferred) vs keywords[] (alias)
  if (Array.isArray(raw.tags)) {
    const { tags, dropped } = normalizeTags(raw.tags);
    if (tags.length > 0) fields.tags = tags;
    if (dropped > 0) warnings.push(`Dropped ${dropped} unrecognised entries from 'tags'.`);
    if (Array.isArray(raw.keywords) && raw.keywords.length > 0 && tags.length > 0) {
      warnings.push("Both 'tags' and 'keywords' provided; using 'tags' and ignoring 'keywords'.");
    }
  } else if (Array.isArray(raw.keywords) && raw.keywords.length > 0) {
    const { tags, dropped } = normalizeKeywordsToTags(raw.keywords);
    if (tags.length > 0) fields.tags = tags;
    if (dropped > 0) warnings.push(`Dropped ${dropped} non-string entries from 'keywords'.`);
  }

  const abstractNote = pickString(raw, ["abstractNote", "abstract"]);
  if (abstractNote) fields.abstractNote = abstractNote;

  const doiRaw = pickString(raw, ["DOI", "doi"]);
  if (doiRaw) {
    try {
      fields.DOI = cleanDoi(doiRaw);
    } catch (error) {
      warnings.push(
        `Invalid DOI '${doiRaw}' dropped (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }

  const publication = pickString(raw, ["publicationTitle", "publication", "journal"]);
  if (publication) fields.publicationTitle = publication;

  const accessDate = pickString(raw, ["accessDate", "access-date", "accessedAt"]);
  if (accessDate) fields.accessDate = accessDate;

  const date = pickString(raw, ["date", "year"]);
  if (date) fields.date = date;

  let collections: string[] | undefined;
  if (Array.isArray(raw.collections)) {
    const filtered = raw.collections.filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );
    if (filtered.length > 0) collections = filtered;
  } else if (typeof raw.collections === "string" && raw.collections.length > 0) {
    collections = [raw.collections];
  } else if (typeof raw.collectionKey === "string" && raw.collectionKey.length > 0) {
    collections = [raw.collectionKey];
  }

  // attachFile (preferred) | attach-file (kebab alias). Path validation lives
  // in the consumer (resolveAttachFile in add.ts) so a bad path becomes a
  // per-item failure with code INVALID_ATTACH_FILE rather than aborting the
  // whole batch parse.
  const attachFile = pickString(raw, ["attachFile", "attach-file"]);

  for (const key of Object.keys(raw)) {
    if (RESERVED_INPUT_KEYS.has(key)) continue;
    if (raw[key] === undefined) continue;
    fields[key] = raw[key];
  }

  return {
    itemType,
    title,
    fields,
    collections,
    ...(attachFile ? { attachFile } : {}),
    warnings,
  };
}

async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new JsonInputError(
      "--json - requires piped stdin (no terminal input). Pipe a JSON object or array on stdin.",
    );
  }
  return await readStreamText(process.stdin);
}

async function readSourceText(source: string): Promise<{ text: string; origin: "file" | "stdin" }> {
  if (source === "-") {
    const text = await readStdinText();
    return { text, origin: "stdin" };
  }
  try {
    const text = await readFile(source, "utf8");
    return { text, origin: "file" };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `Unable to read ${source}: ${String(error)}`;
    throw new JsonInputError(message, { source });
  }
}

/**
 * Read a JSON file or stdin and validate the top-level shape.
 *
 * Accepted top-level shapes:
 *   - A non-array JSON object (one item)        → wasArray=false, items=[obj]
 *   - A JSON array of non-array objects (batch) → wasArray=true,  items=[obj, obj, ...]
 *
 * Throws `JsonInputError` (caller maps to INVALID_ARGUMENT) on:
 *   - empty stdin / TTY stdin / unreadable file
 *   - JSON parse failure
 *   - top-level scalar / null
 *   - empty array
 *   - array element that is not a JSON object
 */
export async function readJsonInput(source: string): Promise<JsonInputBundle> {
  const { text, origin } = await readSourceText(source);
  if (!text.trim()) {
    throw new JsonInputError(
      origin === "stdin" ? "--json - received empty stdin." : `--json file '${source}' is empty.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new JsonInputError(
      `Failed to parse --json input as JSON (${error instanceof Error ? error.message : String(error)}).`,
      { source },
    );
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      throw new JsonInputError("--json input array must contain at least one item.");
    }
    for (let i = 0; i < parsed.length; i++) {
      if (!isPlainObject(parsed[i])) {
        throw new JsonInputError(
          `--json input array element at index ${i} is not a JSON object.`,
          { index: i, received: parsed[i] },
        );
      }
    }
    return { items: parsed as unknown[], origin, wasArray: true };
  }

  if (isPlainObject(parsed)) {
    return { items: [parsed], origin, wasArray: false };
  }

  throw new JsonInputError(
    "--json input must be a JSON object or an array of JSON objects.",
    { received: parsed },
  );
}

export { JsonInputError };
