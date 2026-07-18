import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve as resolvePath, sep } from "node:path";

import { resolveConfig, type ConfigOverrides } from "./config.js";
import { fetchWithTimeout, readJsonResponse, type FetchLike } from "./http.js";
import {
  cleanDoi,
  determineDoiItemType,
  extractTitle,
  firstString,
  formatIssuedDate,
  mapCslAuthors,
  mapManualAuthors,
  normalizeSpace,
  sanitizeAbstract,
  deriveShortTitle,
  type ZoteroCreator,
} from "./item-metadata.js";
import { JsonInputError, mapLenientItem, readJsonInput, type AddJsonInput } from "./json-input.js";
import { getSemanticScholarPaper, inferSemanticScholarItemType } from "./s2.js";
import {
  searchByIdentifier,
  translateWebUrl,
  TranslationServerError,
  type TranslationChoice,
  type TranslationItem,
} from "./translation-server.js";
import type { AppConfig } from "./types.js";
import {
  getWriteConfig,
  libraryBaseUrl,
  zoteroJsonHeaders,
  type ZoteroCredentials,
} from "./zotero-http.js";

const DOI_CSL_ACCEPT_HEADER = "application/vnd.citationstyles.csl+json";
const PUBLICATION_FIELDS = ["publicationTitle", "websiteTitle", "bookTitle", "proceedingsTitle"];
const AI_AGENT_TAG = "Added by Zotagent";

const REQUEST_TIMEOUT_MS = 8000;

interface EditableZoteroItem {
  itemType: string;
  title?: string;
  creators?: ZoteroCreator[];
  DOI?: string;
  date?: string;
  url?: string;
  accessDate?: string;
  language?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  abstractNote?: string;
  ISSN?: string;
  ISBN?: string;
  shortTitle?: string;
  libraryCatalog?: string;
  tags?: unknown[];
  collections?: string[];
  relations?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AddInput {
  doi?: string;
  title?: string;
  authors?: string[];
  year?: string;
  publication?: string;
  url?: string;
  urlDate?: string;
  abstract?: string;
  collectionKey?: string;
  itemType?: string;
  attachFile?: string;
}

export interface AddResult {
  itemKey: string;
  title: string;
  itemType: string;
  created: boolean;
  source: "doi" | "manual" | "manual-fallback" | "json" | "url" | "identifier";
  doi?: string;
  identifier?: string;
  s2PaperId?: string;
  attachmentItemKey?: string;
  // Child notes created from translator output (translation-server paths only).
  noteItemKeys?: string[];
  // Optional: omitted from the JSON envelope when empty so a clean run doesn't
  // emit `"warnings": []`. Matches the pattern in recent.ts / metadata.ts.
  warnings?: string[];
}

/**
 * Returned by addFromUrl when the page lists multiple candidate items
 * (translation-server HTTP 300). Nothing was created in Zotero; re-run with
 * `--select <key>` to import one of the candidates.
 */
export interface AddUrlChoicesResult {
  multiple: true;
  url: string;
  choices: TranslationChoice[];
}

export interface AddJsonItemFailure {
  ok: false;
  error: { code: string; message: string };
  title?: string;
  itemType?: string;
}

export type AddJsonItemResult = AddResult | AddJsonItemFailure;

function createWriteToken(): string {
  return randomBytes(16).toString("hex");
}

function encodeDoiPath(doi: string): string {
  return encodeURIComponent(doi).replace(/%2F/gu, "/");
}

// Match Zotero's UI rendering: `YYYY-MM-DD HH:MM:SS` in *local* time. Zotero
// converts ISO-8601 UTC to the user's local zone for display, so emitting the
// SQL-style local form directly avoids the off-by-timezone surprise users see
// when the API stamps a `Z` value for someone in UTC+8.
function currentAccessDate(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `${date} ${time}`;
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  epub: "application/epub+zip",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
};

interface ResolvedAttachFile {
  /** Absolute path on disk. Validated to exist. */
  absolutePath: string;
  /** File basename, also used as the Zotero `filename` field. */
  basename: string;
  /** MIME type inferred from extension; falls back to `application/octet-stream`. */
  contentType: string;
  /**
   * The string Zotero stores in the attachment's `path` field. When the file
   * lives under the configured `attachmentsRoot`, this is the cross-machine-
   * portable `attachments:<rel>` form (Zotero resolves it via the
   * "Linked Attachment Base Directory" setting). Otherwise the absolute path,
   * which works on the current machine but won't follow the database to
   * another device.
   */
  zoteroPath: string;
}

/**
 * Validate `--attach-file <path>` and compute the form Zotero should store.
 * Throws synchronously when the path is empty / missing / not a regular file —
 * callers rely on this to abort *before* creating the parent item, so a bad
 * path can't leave an orphan citation behind.
 */
export function resolveAttachFile(
  rawPath: string,
  attachmentsRoot: string | undefined,
): ResolvedAttachFile {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new Error("attach-file path is empty.");
  }
  const expanded = trimmed.startsWith("~/") || trimmed === "~"
    ? resolvePath(homedir(), trimmed.slice(1).replace(/^\//u, ""))
    : trimmed;
  const absolute = isAbsolute(expanded) ? expanded : resolvePath(process.cwd(), expanded);
  if (!existsSync(absolute)) {
    throw new Error(`attach-file not found: ${absolute}`);
  }
  const stats = statSync(absolute);
  if (!stats.isFile()) {
    throw new Error(`attach-file is not a regular file: ${absolute}`);
  }

  const base = basename(absolute);
  const ext = (base.split(".").pop() || "").toLowerCase();
  const contentType = MIME_BY_EXT[ext] || "application/octet-stream";

  let zoteroPath = absolute;
  if (attachmentsRoot) {
    const root = resolvePath(attachmentsRoot);
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    if (absolute.startsWith(rootWithSep)) {
      zoteroPath = `attachments:${absolute.slice(rootWithSep.length)}`;
    }
  }

  return { absolutePath: absolute, basename: base, contentType, zoteroPath };
}


/**
 * Auto-populate `shortTitle` from `title` when the template supports it and
 * shortTitle isn't already set. Mirrors what Zotero users do by hand. No-op
 * for templates without `shortTitle` (e.g. attachments).
 */
function ensureShortTitle(payload: EditableZoteroItem): void {
  if (!("shortTitle" in payload)) return;
  const existing = typeof payload.shortTitle === "string" ? payload.shortTitle.trim() : "";
  if (existing) return;
  const fullTitle = typeof payload.title === "string" ? payload.title : "";
  const derived = deriveShortTitle(fullTitle);
  if (derived) payload.shortTitle = derived;
}

function inferManualItemType(input: Required<Pick<AddInput, "url" | "publication">> & Pick<AddInput, "itemType">): string {
  if (input.itemType) return input.itemType;
  if (input.url && !input.publication) return "webpage";
  return "journalArticle";
}

function applyPublicationField(payload: EditableZoteroItem, publication: string | undefined): void {
  if (!publication) return;
  for (const field of PUBLICATION_FIELDS) {
    if (!(field in payload)) continue;
    payload[field] = publication;
    return;
  }
}

function ensureAgentTag(payload: EditableZoteroItem): void {
  const tags = Array.isArray(payload.tags) ? [...payload.tags] : [];
  if (!tags.some((tag) => typeof tag === "object" && tag !== null && (tag as { tag?: unknown }).tag === AI_AGENT_TAG)) {
    tags.push({ tag: AI_AGENT_TAG });
  }
  payload.tags = tags;
}

// Keys of a translation-server item that must not be copied verbatim onto the
// template: children and identity fields are handled separately, and
// accessDate needs the CURRENT_TIMESTAMP placeholder resolved.
const TRANSLATION_SPECIAL_KEYS = new Set([
  "itemType",
  "creators",
  "tags",
  "notes",
  "attachments",
  "seeAlso",
  "collections",
  "relations",
  "accessDate",
  "key",
  "version",
  "itemID",
  "id",
]);

function mapTranslationCreators(raw: unknown): ZoteroCreator[] {
  if (!Array.isArray(raw)) return [];
  const creators: ZoteroCreator[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const source = entry as Record<string, unknown>;
    const creatorType =
      typeof source.creatorType === "string" && source.creatorType.trim()
        ? source.creatorType.trim()
        : "author";
    const name = typeof source.name === "string" ? normalizeSpace(source.name) : "";
    const firstName = typeof source.firstName === "string" ? normalizeSpace(source.firstName) : "";
    const lastName = typeof source.lastName === "string" ? normalizeSpace(source.lastName) : "";
    if (name) {
      creators.push({ creatorType, name });
      continue;
    }
    // fieldMode 1 is Zotero's internal single-field form; the API expects it
    // as `name`. translation-server normally converts already, but be lenient.
    if (source.fieldMode === 1 && lastName) {
      creators.push({ creatorType, name: lastName });
      continue;
    }
    if (firstName || lastName) {
      const creator: ZoteroCreator = { creatorType };
      if (firstName) creator.firstName = firstName;
      if (lastName) creator.lastName = lastName;
      creators.push(creator);
    }
  }
  return creators;
}

// Translator tags arrive as strings or {tag, type} objects; type 1 marks
// automatic (publisher keyword) tags and is preserved so the items look the
// same as a browser-connector save.
function mapTranslationTags(raw: unknown): Array<{ tag: string; type?: number }> {
  if (!Array.isArray(raw)) return [];
  const tags: Array<{ tag: string; type?: number }> = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const tag = normalizeSpace(entry);
      if (tag) tags.push({ tag });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const tagValue = (entry as { tag?: unknown }).tag;
    if (typeof tagValue !== "string") continue;
    const tag = normalizeSpace(tagValue);
    if (!tag) continue;
    const type = (entry as { type?: unknown }).type;
    tags.push(typeof type === "number" ? { tag, type } : { tag });
  }
  return tags;
}

/**
 * Merge a translation-server item (already Zotero API JSON, produced by the
 * same translators the browser connector runs) onto a fresh /items/new
 * template. Field values are template-gated like the JSON path, so a schema
 * drift between the server's bundled translators and the live API can't
 * produce a 400.
 */
function buildItemFromTranslation(
  template: EditableZoteroItem,
  item: TranslationItem,
): EditableZoteroItem {
  const payload = structuredClone(template);

  for (const [key, value] of Object.entries(item)) {
    if (TRANSLATION_SPECIAL_KEYS.has(key)) continue;
    if (!(key in payload)) continue;
    // Zotero data fields are all strings. Keep values verbatim (fields like
    // `extra` are legitimately multi-line), only skipping blanks so template
    // defaults survive.
    if (typeof value !== "string" || !value.trim()) continue;
    payload[key] = value;
  }

  if (typeof payload.title !== "string" || !payload.title.trim()) {
    throw new TranslationServerError(
      "TRANSLATION_NO_TITLE",
      "Translated metadata did not include a title.",
    );
  }

  const creators = mapTranslationCreators(item.creators);
  if (creators.length > 0) payload.creators = creators;

  // Only stamp accessDate on items that carry a URL (web pages, online
  // articles), matching the doi.org CSL path (buildItemFromCsl) and Zotero's
  // own convention — a print book resolved by ISBN should not get an access
  // date even though the translator emits a CURRENT_TIMESTAMP placeholder. The
  // translator value is always "now", so re-stamp it in zotagent's local
  // YYYY-MM-DD HH:MM:SS form (see currentAccessDate).
  if ("accessDate" in payload && typeof payload.url === "string" && payload.url) {
    payload.accessDate = currentAccessDate();
  }

  const tags = mapTranslationTags(item.tags);
  if (tags.length > 0) payload.tags = tags;

  ensureAgentTag(payload);
  ensureShortTitle(payload);

  return payload;
}

interface PickedTranslation {
  item: TranslationItem;
  /** Note HTML of child-note entries that reference the picked item. */
  childNotes: string[];
}

/**
 * Reduce a translation result to the one regular item to create, plus its
 * child notes. translation-server flattens children in Zotero API JSON form:
 * a note arrives as a sibling array entry `{itemType: "note", parentItem:
 * <parent temp key>, note}` (attachments are dropped by the server entirely).
 * Extra regular items (rare — a single page save almost always yields one)
 * are dropped with a warning rather than silently multiplying the add.
 */
function pickSingleTranslationItem(
  items: TranslationItem[],
  source: string,
  warnings: string[],
): PickedTranslation {
  const regular = items.filter((item) => {
    const itemType = typeof item.itemType === "string" ? item.itemType : "";
    return itemType !== "" && itemType !== "attachment" && itemType !== "note";
  });
  if (regular.length === 0) {
    throw new TranslationServerError(
      "TRANSLATION_NO_ITEMS",
      `Translation returned no regular item for ${source}.`,
    );
  }
  if (regular.length > 1) {
    warnings.push(`Translation returned ${regular.length} items for ${source}; created the first.`);
  }
  const picked = regular[0];
  const pickedKey = typeof picked.key === "string" ? picked.key : "";

  const childNotes: string[] = [];
  for (const entry of items) {
    if (entry === picked) continue;
    if (entry.itemType !== "note") continue;
    const parentItem = typeof entry.parentItem === "string" ? entry.parentItem : "";
    if (!pickedKey || parentItem !== pickedKey) continue;
    const note = typeof entry.note === "string" ? entry.note : "";
    if (note.trim()) childNotes.push(note);
  }
  return { item: picked, childNotes };
}

function requireTranslationServer(config: AppConfig, flagLabel: string): string {
  if (!config.translationServerUrl) {
    throw new TranslationServerError(
      "TRANSLATION_SERVER_NOT_CONFIGURED",
      `${flagLabel} requires a Zotero translation-server. Set translationServerUrl in ~/.zotagent/config.json ` +
        `(or ZOTAGENT_TRANSLATION_SERVER_URL), e.g. http://127.0.0.1:1969 — ` +
        `start one with: docker run -d -p 1969:1969 zotero/translation-server`,
    );
  }
  return config.translationServerUrl;
}

function normalizeInput(input: AddInput): Required<Omit<AddInput, "doi" | "itemType" | "attachFile">> & Pick<AddInput, "doi" | "itemType" | "attachFile"> {
  return {
    ...(input.doi ? { doi: normalizeSpace(input.doi) } : {}),
    title: normalizeSpace(input.title || ""),
    authors: (input.authors || []).map((author) => normalizeSpace(author)).filter(Boolean),
    year: normalizeSpace(input.year || ""),
    publication: normalizeSpace(input.publication || ""),
    url: normalizeSpace(input.url || ""),
    urlDate: normalizeSpace(input.urlDate || ""),
    abstract: normalizeSpace(input.abstract || ""),
    collectionKey: normalizeSpace(input.collectionKey || ""),
    ...(input.itemType ? { itemType: normalizeSpace(input.itemType) } : {}),
    // Don't run attachFile through normalizeSpace — paths can legitimately
    // contain runs of spaces and we resolve them verbatim.
    ...(input.attachFile ? { attachFile: input.attachFile.trim() } : {}),
  };
}

function applyCollectionKey(payload: EditableZoteroItem, collectionKey: string | undefined): void {
  if (!collectionKey || !("collections" in payload)) return;
  payload.collections = [collectionKey];
}

async function fetchTemplate(itemType: string, fetchImpl: FetchLike): Promise<EditableZoteroItem> {
  const url = `https://api.zotero.org/items/new?itemType=${encodeURIComponent(itemType)}`;
  const response = await fetchWithTimeout(fetchImpl, url, {
    headers: zoteroJsonHeaders(undefined, { Accept: "application/json" }),
  }, REQUEST_TIMEOUT_MS);
  return await readJsonResponse<EditableZoteroItem>(response, url);
}

async function fetchCslJsonForDoi(doi: string, fetchImpl: FetchLike): Promise<Record<string, unknown>> {
  const url = `https://doi.org/${encodeDoiPath(doi)}`;
  const response = await fetchWithTimeout(fetchImpl, url, {
    headers: {
      Accept: DOI_CSL_ACCEPT_HEADER,
    },
  }, REQUEST_TIMEOUT_MS);
  return await readJsonResponse<Record<string, unknown>>(response, url);
}

function applyManualOverrides(
  payload: EditableZoteroItem,
  input: ReturnType<typeof normalizeInput>,
): void {
  if (input.title) {
    payload.title = input.title;
    // The new title invalidates any auto-derived shortTitle from earlier in
    // the build (e.g. CSL metadata on the DOI path). Clear it so the
    // ensureShortTitle pass that runs before createItem re-derives from the
    // override rather than leaking the old DOI-derived prefix.
    if ("shortTitle" in payload) payload.shortTitle = "";
  }
  if (input.authors.length > 0) payload.creators = mapManualAuthors(input.authors);
  if (input.year && "date" in payload) payload.date = input.year;
  applyPublicationField(payload, input.publication || undefined);
  if (input.url && "url" in payload) payload.url = input.url;
  if (input.urlDate && "accessDate" in payload) payload.accessDate = input.urlDate;
  if (input.abstract && "abstractNote" in payload) payload.abstractNote = input.abstract;
  applyCollectionKey(payload, input.collectionKey || undefined);
}

function buildItemFromCsl(
  template: EditableZoteroItem,
  cslJson: Record<string, unknown>,
  doi: string,
): EditableZoteroItem {
  const payload = structuredClone(template);
  const { fullTitle, shortTitle } = extractTitle(cslJson);
  if (!fullTitle) {
    throw new Error("DOI metadata did not include a title.");
  }

  payload.title = fullTitle;
  if ("DOI" in payload) payload.DOI = doi;
  if (shortTitle && "shortTitle" in payload) payload.shortTitle = shortTitle;

  const url = firstString(cslJson.URL);
  if (url && "url" in payload) payload.url = url;
  if (url && "accessDate" in payload) payload.accessDate = currentAccessDate();

  const language = firstString(cslJson.language);
  if (language && "language" in payload) payload.language = language;

  const volume = firstString(cslJson.volume);
  if (volume && "volume" in payload) payload.volume = volume;

  const issue = firstString(cslJson.issue);
  if (issue && "issue" in payload) payload.issue = issue;

  const page = firstString(cslJson.page);
  if (page && "pages" in payload) payload.pages = page;

  const publisher = firstString(cslJson.publisher);
  if (publisher && payload.itemType !== "journalArticle" && "publisher" in payload) {
    payload.publisher = publisher;
  }

  const abstractNote = sanitizeAbstract(cslJson.abstract);
  if (abstractNote && "abstractNote" in payload) payload.abstractNote = abstractNote;

  const issn = firstString(cslJson.ISSN);
  if (issn && "ISSN" in payload) payload.ISSN = issn;

  const isbn = firstString(cslJson.ISBN);
  if (isbn && "ISBN" in payload) payload.ISBN = isbn;

  const date = formatIssuedDate(cslJson.issued);
  if (date && "date" in payload) payload.date = date;

  const publication = firstString(cslJson["container-title"]);
  applyPublicationField(payload, publication || undefined);

  const creators = mapCslAuthors(cslJson);
  if (creators.length > 0) payload.creators = creators;
  ensureAgentTag(payload);
  ensureShortTitle(payload);

  return payload;
}

function buildManualItem(
  template: EditableZoteroItem,
  input: ReturnType<typeof normalizeInput>,
): EditableZoteroItem {
  const payload = structuredClone(template);
  if (!input.title) {
    throw new Error("Manual item creation requires --title.");
  }
  applyManualOverrides(payload, input);
  ensureAgentTag(payload);
  ensureShortTitle(payload);
  return payload;
}

async function createItem(
  config: ZoteroCredentials,
  payload: EditableZoteroItem,
  fetchImpl: FetchLike,
): Promise<string> {
  const url = `${libraryBaseUrl(config)}/items`;
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: "POST",
    headers: zoteroJsonHeaders(config.apiKey, { "Zotero-Write-Token": createWriteToken() }),
    body: JSON.stringify([payload]),
  }, REQUEST_TIMEOUT_MS);
  const data = await readJsonResponse<{ success?: Record<string, string>; successful?: Record<string, { key?: string }> }>(
    response,
    url,
  );

  const successKey = data.success?.["0"];
  if (successKey) return successKey;

  const successfulKey = data.successful?.["0"]?.key;
  if (successfulKey) return successfulKey;

  throw new Error(`Zotero item creation did not return an item key: ${JSON.stringify(data)}`);
}

async function fetchAttachmentTemplate(
  linkMode: string,
  fetchImpl: FetchLike,
): Promise<EditableZoteroItem> {
  const url = `https://api.zotero.org/items/new?itemType=attachment&linkMode=${encodeURIComponent(linkMode)}`;
  const response = await fetchWithTimeout(fetchImpl, url, {
    headers: zoteroJsonHeaders(undefined, { Accept: "application/json" }),
  }, REQUEST_TIMEOUT_MS);
  return await readJsonResponse<EditableZoteroItem>(response, url);
}

/**
 * Create a `linkMode: linked_file` child attachment under `parentKey`. Linked
 * (not imported) so the file stays on disk and Zotero's storage quota is
 * untouched — the user opens the parent item, clicks the attachment, and
 * Zotero opens the local file directly. For cross-machine portability the
 * caller passes a `zoteroPath` of the form `attachments:<rel>`, which Zotero
 * resolves via the "Linked Attachment Base Directory" preference.
 */
async function createLinkedFileAttachment(
  parentKey: string,
  attach: ResolvedAttachFile,
  config: ZoteroCredentials,
  fetchImpl: FetchLike,
): Promise<string> {
  const template = await fetchAttachmentTemplate("linked_file", fetchImpl);
  const payload = structuredClone(template);
  // `parentItem` and `title` aren't on the empty template but the schema
  // accepts them on POST, so set directly. `path` / `contentType` are gated
  // through the template — both are present for linked_file. Don't try to
  // set `filename`: Zotero's schema rejects it for linked_file with HTTP 400
  // ("'filename' is valid only for imported and embedded-image attachments").
  // For linked_file Zotero uses the basename of `path` as the display label.
  payload.parentItem = parentKey;
  payload.title = "Full Text PDF";
  if ("path" in payload) payload.path = attach.zoteroPath;
  if ("contentType" in payload) payload.contentType = attach.contentType;
  return await createItem(config, payload, fetchImpl);
}

/**
 * After createItem returns the parent itemKey, try to attach the file as a
 * linked_file child. Failures here don't abort — the parent item already
 * exists in Zotero and is worth returning to the caller; we just record a
 * warning so the user can re-attach manually. Validation of the path itself
 * happens earlier (resolveAttachFile) so a bad path never creates an orphan.
 */
async function maybeCreateAttachment(
  parentKey: string,
  attach: ResolvedAttachFile | undefined,
  config: ZoteroCredentials,
  fetchImpl: FetchLike,
  warnings: string[],
): Promise<string | undefined> {
  if (!attach) return undefined;
  try {
    return await createLinkedFileAttachment(parentKey, attach, config, fetchImpl);
  } catch (error) {
    warnings.push(
      `Created parent item but attachment failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/**
 * Create child note items under `parentKey` from translator-provided note
 * HTML. Mirrors what the browser connector saves. Failures don't abort —
 * the parent item already exists and is worth returning; each failure is
 * surfaced as a warning instead.
 */
async function createChildNotes(
  parentKey: string,
  notes: string[],
  config: ZoteroCredentials,
  fetchImpl: FetchLike,
  warnings: string[],
): Promise<string[]> {
  if (notes.length === 0) return [];
  const noteKeys: string[] = [];
  let template: EditableZoteroItem | undefined;
  for (const note of notes) {
    try {
      template ??= await fetchTemplate("note", fetchImpl);
      const payload = structuredClone(template);
      payload.note = note;
      payload.parentItem = parentKey;
      noteKeys.push(await createItem(config, payload, fetchImpl));
    } catch (error) {
      warnings.push(
        `Created parent item but a child note failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return noteKeys;
}

interface WriteContext {
  config: AppConfig;
  writeConfig: ZoteroCredentials;
  input: ReturnType<typeof normalizeInput>;
  attach: ResolvedAttachFile | undefined;
  warnings: string[];
}

/**
 * Shared preamble of every add path: resolve config (checking the
 * translation-server prerequisite before write credentials when asked — its
 * absence is the more actionable error when both are missing), normalize the
 * input, apply the config-default collection key, and validate --attach-file
 * up front so a bad path can never leave an orphan parent item behind.
 */
function prepareWrite(
  rawInput: AddInput,
  overrides: ConfigOverrides,
  options: { requireServerFor?: string } = {},
): { ctx: WriteContext; serverUrl?: string } {
  const config = resolveConfig(overrides);
  const serverUrl = options.requireServerFor
    ? requireTranslationServer(config, options.requireServerFor)
    : undefined;
  const writeConfig = getWriteConfig(config);
  const normalizedInput = normalizeInput(rawInput);
  const input = {
    ...normalizedInput,
    collectionKey: normalizedInput.collectionKey || config.zoteroCollectionKey || "",
  };
  const attach = input.attachFile
    ? resolveAttachFile(input.attachFile, config.attachmentsRoot)
    : undefined;
  return {
    ctx: { config, writeConfig, input, attach, warnings: [...config.warnings] },
    ...(serverUrl ? { serverUrl } : {}),
  };
}

/**
 * Shared tail of every add path: create the parent item, then translator
 * child notes, then the optional --attach-file child, and assemble the
 * AddResult. Optional fields are omitted from the JSON envelope when empty.
 */
async function createWithChildren(
  ctx: Pick<WriteContext, "writeConfig" | "attach" | "warnings">,
  payload: EditableZoteroItem,
  meta: { source: AddResult["source"]; doi?: string; childNotes?: string[] },
  fetchImpl: FetchLike,
): Promise<AddResult> {
  const itemKey = await createItem(ctx.writeConfig, payload, fetchImpl);
  const noteItemKeys = await createChildNotes(
    itemKey,
    meta.childNotes ?? [],
    ctx.writeConfig,
    fetchImpl,
    ctx.warnings,
  );
  const attachmentItemKey = await maybeCreateAttachment(
    itemKey,
    ctx.attach,
    ctx.writeConfig,
    fetchImpl,
    ctx.warnings,
  );
  return {
    itemKey,
    title: typeof payload.title === "string" ? payload.title : "",
    itemType: payload.itemType,
    created: true,
    source: meta.source,
    ...(meta.doi ? { doi: meta.doi } : {}),
    ...(attachmentItemKey ? { attachmentItemKey } : {}),
    ...(noteItemKeys.length > 0 ? { noteItemKeys } : {}),
    ...(ctx.warnings.length > 0 ? { warnings: ctx.warnings } : {}),
  };
}

/**
 * Shared tail of the translation-server add paths: fetch the template for
 * the translated item, apply manual override flags, then run the create
 * tail with the translator's child notes. The DOI on the result is the one
 * actually written to the item (translators may normalize the requested
 * form); `ensureDoi` only fills in when the schema's DOI field is blank.
 */
async function createFromTranslation(
  ctx: WriteContext,
  picked: PickedTranslation,
  source: "doi" | "url" | "identifier",
  fetchImpl: FetchLike,
  ensureDoi?: string,
): Promise<AddResult> {
  const itemType = ctx.input.itemType || String(picked.item.itemType);
  const template = await fetchTemplate(itemType, fetchImpl);
  const payload = buildItemFromTranslation(template, picked.item);
  if (ensureDoi && "DOI" in payload && !payload.DOI) {
    payload.DOI = ensureDoi;
  }
  applyManualOverrides(payload, ctx.input);
  ensureShortTitle(payload);
  const writtenDoi = typeof payload.DOI === "string" && payload.DOI ? payload.DOI : undefined;
  return await createWithChildren(
    ctx,
    payload,
    { source, ...(writtenDoi ? { doi: writtenDoi } : {}), childNotes: picked.childNotes },
    fetchImpl,
  );
}

export async function addToZotero(
  input: AddInput,
  overrides: ConfigOverrides = {},
  fetchImpl: FetchLike = fetch,
): Promise<AddResult> {
  const { ctx } = prepareWrite(input, overrides);

  if (!ctx.input.doi && !ctx.input.title) {
    throw new Error("Provide --doi <doi> or --title <text>.");
  }

  const manualItemType = inferManualItemType({
    itemType: ctx.input.itemType,
    publication: ctx.input.publication,
    url: ctx.input.url,
  });

  if (ctx.input.doi) {
    const cleanedDoi = cleanDoi(ctx.input.doi);
    try {
      if (ctx.config.translationServerUrl) {
        // Same translator chain the browser connector uses for identifiers
        // (Crossref / DataCite via DOI Content Negotiation) — noticeably
        // richer than the raw CSL JSON mapping below.
        const items = await searchByIdentifier(ctx.config.translationServerUrl, cleanedDoi, fetchImpl);
        const picked = pickSingleTranslationItem(items, `DOI ${cleanedDoi}`, ctx.warnings);
        // Spread order matters: the translation result reports the DOI
        // actually written to the item (translators may normalize the
        // requested form); cleanedDoi only fills in when the item type has
        // no DOI field.
        return { doi: cleanedDoi, ...(await createFromTranslation(ctx, picked, "doi", fetchImpl, cleanedDoi)) };
      }
      const cslJson = await fetchCslJsonForDoi(cleanedDoi, fetchImpl);
      const itemType = ctx.input.itemType || determineDoiItemType(cslJson);
      const template = await fetchTemplate(itemType, fetchImpl);
      const payload = buildItemFromCsl(template, cslJson, cleanedDoi);
      applyManualOverrides(payload, ctx.input);
      ensureShortTitle(payload);
      return await createWithChildren(ctx, payload, { source: "doi", doi: cleanedDoi }, fetchImpl);
    } catch (error) {
      if (!ctx.input.title) {
        throw error;
      }
      ctx.warnings.push(
        `DOI import failed; created item from manual fields instead. ${error instanceof Error ? error.message : String(error)}`,
      );
      const template = await fetchTemplate(manualItemType, fetchImpl);
      const payload = buildManualItem(template, ctx.input);
      if ("DOI" in payload) payload.DOI = cleanedDoi;
      return await createWithChildren(ctx, payload, { source: "manual-fallback", doi: cleanedDoi }, fetchImpl);
    }
  }

  const template = await fetchTemplate(manualItemType, fetchImpl);
  const payload = buildManualItem(template, ctx.input);
  return await createWithChildren(ctx, payload, { source: "manual" }, fetchImpl);
}

/**
 * Translate a web page through the configured translation-server (`/web`) —
 * the same site translators the Zotero browser connector runs — and create
 * the resulting item. Pages that list multiple candidates (HTTP 300) return
 * `{multiple: true, choices}` without creating anything; pass `select` with
 * a choice key to import one of them.
 */
export async function addFromUrl(
  pageUrl: string,
  input: Omit<AddInput, "doi"> = {},
  options: { select?: string } = {},
  overrides: ConfigOverrides = {},
  fetchImpl: FetchLike = fetch,
): Promise<AddResult | AddUrlChoicesResult> {
  const trimmedUrl = pageUrl.trim();
  if (!trimmedUrl) {
    throw new Error("Provide a non-empty URL for --from-url.");
  }
  const { ctx, serverUrl } = prepareWrite(input, overrides, { requireServerFor: "add --from-url" });

  const outcome = await translateWebUrl(serverUrl!, trimmedUrl, options.select, fetchImpl);
  if (outcome.kind === "choices") {
    return { multiple: true, url: trimmedUrl, choices: outcome.choices };
  }

  const picked = pickSingleTranslationItem(outcome.items, trimmedUrl, ctx.warnings);
  return await createFromTranslation(ctx, picked, "url", fetchImpl);
}

/**
 * Resolve an identifier (DOI, ISBN, PMID, or arXiv ID) through the configured
 * translation-server (`/search`) and create the resulting item. This is the
 * CLI equivalent of Zotero's "Add Item by Identifier" magic wand.
 */
export async function addFromIdentifier(
  identifier: string,
  input: Omit<AddInput, "doi"> = {},
  overrides: ConfigOverrides = {},
  fetchImpl: FetchLike = fetch,
): Promise<AddResult> {
  const trimmedIdentifier = identifier.trim();
  if (!trimmedIdentifier) {
    throw new Error("Provide a non-empty identifier (DOI, ISBN, PMID, or arXiv ID).");
  }
  const { ctx, serverUrl } = prepareWrite(input, overrides, { requireServerFor: "add --identifier" });

  const items = await searchByIdentifier(serverUrl!, trimmedIdentifier, fetchImpl);
  const picked = pickSingleTranslationItem(items, trimmedIdentifier, ctx.warnings);
  return {
    ...(await createFromTranslation(ctx, picked, "identifier", fetchImpl)),
    identifier: trimmedIdentifier,
  };
}

export async function addS2PaperToZotero(
  paperId: string,
  inputOverrides: Omit<AddInput, "doi"> = {},
  overrides: ConfigOverrides = {},
  fetchImpl: FetchLike = fetch,
): Promise<AddResult> {
  const { paper } = await getSemanticScholarPaper(paperId, overrides, fetchImpl);
  const result = await addToZotero(
    {
      ...(paper.doi ? { doi: paper.doi } : {}),
      title: paper.title,
      authors: paper.authors,
      year: paper.publicationDate || paper.year,
      publication: paper.journal || paper.venue,
      url: paper.doi ? undefined : paper.url || paper.openAccessPdfUrl,
      abstract: paper.abstract,
      itemType: paper.doi ? undefined : inferSemanticScholarItemType(paper),
      ...inputOverrides,
    },
    overrides,
    fetchImpl,
  );

  return {
    ...result,
    s2PaperId: paper.paperId,
  };
}

function classifyJsonAddError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // resolveAttachFile throws synchronously before we touch Zotero; surface
  // these as a distinct code so callers can fix the path and retry without
  // reasoning about Zotero's status codes.
  if (/^attach-file /u.test(message)) {
    return "INVALID_ATTACH_FILE";
  }
  // Zotero rejects an unknown itemType from /items/new with HTTP 4xx; the
  // resulting error message includes the items/new URL and is the most useful
  // signal for an agent caller to retry with a different itemType.
  if (/items\/new\?itemType=/u.test(message)) {
    return "INVALID_ITEM_TYPE";
  }
  return "JSON_ITEM_FAILED";
}

const JSON_INPUT_RESERVED_KEYS = new Set(["title", "itemType"]);

/**
 * Create one or more Zotero items from pre-shaped JSON input. Per-item failures
 * are returned in-place (as `{ok: false, error, title?, itemType?}` entries),
 * never abort the batch. Config / write errors throw and abort the whole call.
 *
 * Field merge precedence:
 *   - `payload.title`       always set from `input.title`
 *   - `publicationTitle`    routed via `applyPublicationField` (book / proceedings
 *                           templates pick `bookTitle` / `proceedingsTitle` etc.)
 *   - other `input.fields`  spread onto template, gated by `key in payload`
 *   - collections           CLI override > per-item collections > config default
 *   - tags                  always appended `{tag: "Added by Zotagent"}` via
 *                           `ensureAgentTag`
 */
export async function addJsonItemsToZotero(
  inputs: AddJsonInput[],
  overrides: ConfigOverrides = {},
  cliCollectionKey?: string,
  fetchImpl: FetchLike = fetch,
): Promise<AddJsonItemResult[]> {
  const config = resolveConfig(overrides);
  const writeConfig = getWriteConfig(config);
  const baseWarnings = config.warnings;

  const results: AddJsonItemResult[] = [];

  for (const input of inputs) {
    try {
      // Validate attach-file before creating the parent so a bad path is
      // surfaced as a per-item failure rather than leaving an orphan in Zotero.
      const attach = input.attachFile
        ? resolveAttachFile(input.attachFile, config.attachmentsRoot)
        : undefined;

      const template = await fetchTemplate(input.itemType, fetchImpl);
      const payload = structuredClone(template);

      payload.title = input.title;

      const fields = { ...input.fields };

      if (typeof fields.publicationTitle === "string") {
        applyPublicationField(payload, fields.publicationTitle);
        delete fields.publicationTitle;
      }

      for (const key of Object.keys(fields)) {
        if (JSON_INPUT_RESERVED_KEYS.has(key)) continue;
        if (!(key in payload)) continue;
        payload[key] = fields[key];
      }

      // Collection routing precedence: CLI --collection-key (single, applies
      // to whole batch) > per-item collections (preserves multi-collection
      // arrays from the input JSON) > config default. Don't reuse
      // applyCollectionKey here because it forces a single-key shape.
      let effectiveCollections: string[] | undefined;
      if (cliCollectionKey && cliCollectionKey.length > 0) {
        effectiveCollections = [cliCollectionKey];
      } else if (input.collections && input.collections.length > 0) {
        effectiveCollections = input.collections;
      } else if (config.zoteroCollectionKey) {
        effectiveCollections = [config.zoteroCollectionKey];
      }
      if (effectiveCollections && effectiveCollections.length > 0 && "collections" in payload) {
        payload.collections = effectiveCollections;
      }

      ensureAgentTag(payload);
      ensureShortTitle(payload);

      const itemWarnings = [...baseWarnings, ...input.warnings];
      results.push(
        await createWithChildren(
          { writeConfig, attach, warnings: itemWarnings },
          payload,
          { source: "json" },
          fetchImpl,
        ),
      );
    } catch (error) {
      results.push({
        ok: false,
        error: {
          code: classifyJsonAddError(error),
          message: error instanceof Error ? error.message : String(error),
        },
        title: input.title,
        itemType: input.itemType,
      });
    }
  }

  return results;
}

/** One request shape per add input kind — the CLI's flag parsing produces
 *  this, and programmatic callers can construct it directly. */
export type AddRequest =
  | { kind: "doi-or-manual"; input: AddInput }
  | { kind: "url"; url: string; select?: string; input?: Omit<AddInput, "doi"> }
  | { kind: "identifier"; identifier: string; input?: Omit<AddInput, "doi"> }
  | { kind: "s2"; paperId: string; input?: Omit<AddInput, "doi"> };

/**
 * Single entry point for the four single-item add kinds. Returns the created
 * item's AddResult, or the choices list when a --from-url page offers
 * multiple candidates (nothing created; re-run with select).
 */
export async function runAdd(
  request: AddRequest,
  overrides: ConfigOverrides = {},
  fetchImpl: FetchLike = fetch,
): Promise<AddResult | AddUrlChoicesResult> {
  switch (request.kind) {
    case "url":
      return await addFromUrl(
        request.url,
        request.input ?? {},
        request.select ? { select: request.select } : {},
        overrides,
        fetchImpl,
      );
    case "identifier":
      return await addFromIdentifier(request.identifier, request.input ?? {}, overrides, fetchImpl);
    case "s2":
      return await addS2PaperToZotero(request.paperId, request.input ?? {}, overrides, fetchImpl);
    case "doi-or-manual":
      return await addToZotero(request.input, overrides, fetchImpl);
  }
}

/**
 * The JSON batch flow: read the bundle, leniently map each raw item, and
 * create the mappable ones. Results line up 1:1 with the input array —
 * parse failures hold their position as `{ok: false}` entries, and per-item
 * write failures are reported in-place by addJsonItemsToZotero. Read errors
 * and JsonInputError from the bundle itself propagate to the caller.
 */
export async function runAddJson(
  source: string,
  overrides: ConfigOverrides = {},
  cliCollectionKey?: string,
  fetchImpl: FetchLike = fetch,
): Promise<AddJsonItemResult[]> {
  const bundle = await readJsonInput(source);
  type Stage =
    | { kind: "ready"; input: AddJsonInput }
    | { kind: "failed"; failure: AddJsonItemFailure };
  const stages: Stage[] = [];
  for (const raw of bundle.items) {
    try {
      stages.push({ kind: "ready", input: mapLenientItem(raw) });
    } catch (mapError) {
      if (mapError instanceof JsonInputError) {
        stages.push({
          kind: "failed",
          failure: {
            ok: false,
            error: { code: "INVALID_INPUT", message: mapError.message },
          },
        });
        continue;
      }
      throw mapError;
    }
  }
  const readyInputs = stages
    .filter((s): s is Extract<Stage, { kind: "ready" }> => s.kind === "ready")
    .map((s) => s.input);
  const successResults = await addJsonItemsToZotero(readyInputs, overrides, cliCollectionKey, fetchImpl);
  let resultCursor = 0;
  return stages.map((stage) =>
    stage.kind === "ready" ? successResults[resultCursor++] : stage.failure,
  );
}
