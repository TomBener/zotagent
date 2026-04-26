import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve as resolvePath, sep } from "node:path";

import { resolveConfig, type ConfigOverrides } from "./config.js";
import type { AddJsonInput } from "./json-input.js";
import { getSemanticScholarPaper, inferSemanticScholarItemType } from "./s2.js";
import type { AppConfig, ZoteroLibraryType } from "./types.js";

const DOI_CSL_ACCEPT_HEADER = "application/vnd.citationstyles.csl+json";
const CSL_TO_ZOTERO_ITEM_TYPE: Record<string, string> = {
  "article-journal": "journalArticle",
  "journal-article": "journalArticle",
  "paper-conference": "conferencePaper",
  chapter: "bookSection",
  book: "book",
  "edited-book": "book",
  report: "report",
  thesis: "thesis",
  webpage: "webpage",
  "post-weblog": "webpage",
  "article-magazine": "magazineArticle",
  "article-newspaper": "newspaperArticle",
};

const PUBLICATION_FIELDS = ["publicationTitle", "websiteTitle", "bookTitle", "proceedingsTitle"];
const DOI_URL_PREFIX_RE = /^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/iu;
const DOI_VALID_RE = /^10\.\S+\/\S+$/iu;
const TAG_RE = /<[^>]+>/gu;
const AI_AGENT_TAG = "Added by AI Agent";

type FetchLike = typeof fetch;
type ZoteroCreator = Record<string, string>;
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

interface AddInput {
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
  source: "doi" | "manual" | "manual-fallback" | "json";
  doi?: string;
  s2PaperId?: string;
  attachmentItemKey?: string;
  // Optional: omitted from the JSON envelope when empty so a clean run doesn't
  // emit `"warnings": []`. Matches the pattern in recent.ts / metadata.ts.
  warnings?: string[];
}

export interface AddJsonItemFailure {
  ok: false;
  error: { code: string; message: string };
  title?: string;
  itemType?: string;
}

export type AddJsonItemResult = AddResult | AddJsonItemFailure;

interface ResolvedWriteConfig {
  apiKey: string;
  libraryId: string;
  libraryType: ZoteroLibraryType;
}

function createWriteToken(): string {
  return randomBytes(16).toString("hex");
}

function normalizeSpace(value: string): string {
  return value.replace(/\u00a0/gu, " ").replace(/\s+/gu, " ").trim();
}

export function cleanDoi(rawDoi: string): string {
  const cleaned = decodeURIComponent(rawDoi || "")
    .trim()
    .replace(DOI_URL_PREFIX_RE, "")
    .replace(/\/+$/u, "");
  if (!cleaned || !DOI_VALID_RE.test(cleaned)) {
    throw new Error(`Invalid DOI: ${rawDoi}`);
  }
  return cleaned;
}

function encodeDoiPath(doi: string): string {
  return encodeURIComponent(doi).replace(/%2F/gu, "/");
}

function formatIssuedDate(issuedValue: unknown): string {
  if (!issuedValue || typeof issuedValue !== "object") return "";
  const dateParts = (issuedValue as { "date-parts"?: unknown[] })["date-parts"];
  if (!Array.isArray(dateParts) || dateParts.length === 0) return "";
  const firstPart = dateParts[0];
  if (!Array.isArray(firstPart) || firstPart.length === 0) return "";

  const cleanedParts: string[] = [];
  for (const part of firstPart.slice(0, 3)) {
    if (typeof part !== "number" || !Number.isInteger(part)) break;
    if (cleanedParts.length === 0) {
      cleanedParts.push(`${part}`.padStart(4, "0"));
    } else {
      cleanedParts.push(`${part}`.padStart(2, "0"));
    }
  }
  return cleanedParts.join("-");
}

function currentAccessDate(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
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

function firstString(value: unknown): string {
  if (typeof value === "string") return normalizeSpace(value);
  if (!Array.isArray(value)) return "";
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const normalized = normalizeSpace(entry);
    if (normalized) return normalized;
  }
  return "";
}

function sanitizeAbstract(value: unknown): string {
  if (typeof value !== "string") return "";
  return normalizeSpace(value.replace(TAG_RE, " "));
}

function extractTitle(cslJson: Record<string, unknown>): { fullTitle: string; shortTitle?: string } {
  const title = firstString(cslJson.title);
  const subtitle = firstString(cslJson.subtitle);
  const explicitShortTitle = firstString(cslJson["short-title"]);
  const fullTitle = title && subtitle ? `${title}: ${subtitle}` : title;
  if (!fullTitle) return { fullTitle: "" };
  if (explicitShortTitle) {
    return { fullTitle, shortTitle: explicitShortTitle };
  }
  if (title && subtitle) {
    return { fullTitle, shortTitle: title };
  }
  return { fullTitle };
}

function inferManualItemType(input: Required<Pick<AddInput, "url" | "publication">> & Pick<AddInput, "itemType">): string {
  if (input.itemType) return input.itemType;
  if (input.url && !input.publication) return "webpage";
  return "journalArticle";
}

function determineDoiItemType(cslJson: Record<string, unknown>): string {
  const cslType = firstString(cslJson.type);
  const publisher = firstString(cslJson.publisher).toLowerCase();
  const url = firstString(cslJson.URL).toLowerCase();
  const containerTitle = firstString(cslJson["container-title"]);
  if (cslType === "article" && (publisher === "arxiv" || url.includes("arxiv.org"))) {
    return "preprint";
  }
  if (cslType === "article" && containerTitle) {
    return "journalArticle";
  }
  return CSL_TO_ZOTERO_ITEM_TYPE[cslType] ?? "document";
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

function parseAuthorName(rawAuthor: string): ZoteroCreator | null {
  const author = normalizeSpace(rawAuthor);
  if (!author) return null;

  if (author.includes(",")) {
    const [lastName, firstName] = author.split(",", 2).map((value) => normalizeSpace(value));
    if (lastName || firstName) {
      const creator: ZoteroCreator = {
        creatorType: "author",
      };
      if (firstName) creator.firstName = firstName;
      if (lastName) creator.lastName = lastName;
      return creator;
    }
  }

  const parts = author.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    return {
      creatorType: "author",
      firstName: parts.slice(0, -1).join(" "),
      lastName: parts.at(-1)!,
    };
  }

  return {
    creatorType: "author",
    name: author,
  };
}

export function mapManualAuthors(authors: string[]): ZoteroCreator[] {
  return authors.map(parseAuthorName).filter((value): value is ZoteroCreator => value !== null);
}

function mapCslAuthors(cslJson: Record<string, unknown>): ZoteroCreator[] {
  const authorList = Array.isArray(cslJson.author) ? cslJson.author : [];
  return authorList
    .map((author) => {
      if (!author || typeof author !== "object") return null;
      const family = normalizeSpace(String((author as { family?: unknown }).family || ""));
      const given = normalizeSpace(String((author as { given?: unknown }).given || ""));
      const literal = normalizeSpace(String((author as { literal?: unknown }).literal || ""));
      if (family || given) {
        const creator: ZoteroCreator = {
          creatorType: "author",
        };
        if (given) creator.firstName = given;
        if (family) creator.lastName = family;
        return creator;
      }
      if (literal) {
        return {
          creatorType: "author",
          name: literal,
        };
      }
      return null;
    })
    .filter((value): value is ZoteroCreator => value !== null);
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

function getWriteConfig(config: AppConfig): ResolvedWriteConfig {
  if (!config.zoteroLibraryId || !config.zoteroApiKey || !config.zoteroLibraryType) {
    throw new Error(
      "Missing Zotero write config. Set zoteroLibraryId, zoteroLibraryType, and zoteroApiKey in ~/.zotagent/config.json or ZOTAGENT_ZOTERO_* environment variables.",
    );
  }
  return {
    apiKey: config.zoteroApiKey,
    libraryId: config.zoteroLibraryId,
    libraryType: config.zoteroLibraryType,
  };
}

function libraryBaseUrl(config: ResolvedWriteConfig): string {
  const prefix = config.libraryType === "group" ? "groups" : "users";
  return `https://api.zotero.org/${prefix}/${encodeURIComponent(config.libraryId)}`;
}

function buildHeaders(apiKey?: string, extra: Record<string, string> = {}): HeadersInit {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Zotero-API-Version": "3",
    ...(apiKey ? { "Zotero-API-Key": apiKey } : {}),
    ...extra,
  };
}

async function readJsonResponse<T>(response: Response, url: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    let detail = text.trim();
    if (!detail) detail = response.statusText;
    throw new Error(`Request failed (${response.status}) for ${url}: ${detail}`);
  }
  if (!text.trim()) {
    throw new Error(`Expected JSON response from ${url}`);
  }
  return JSON.parse(text) as T;
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  input: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms for ${input}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTemplate(itemType: string, fetchImpl: FetchLike): Promise<EditableZoteroItem> {
  const url = `https://api.zotero.org/items/new?itemType=${encodeURIComponent(itemType)}`;
  const response = await fetchWithTimeout(fetchImpl, url, {
    headers: buildHeaders(undefined, { Accept: "application/json" }),
  });
  return await readJsonResponse<EditableZoteroItem>(response, url);
}

async function fetchCslJsonForDoi(doi: string, fetchImpl: FetchLike): Promise<Record<string, unknown>> {
  const url = `https://doi.org/${encodeDoiPath(doi)}`;
  const response = await fetchWithTimeout(fetchImpl, url, {
    headers: {
      Accept: DOI_CSL_ACCEPT_HEADER,
    },
  });
  return await readJsonResponse<Record<string, unknown>>(response, url);
}

function applyManualOverrides(
  payload: EditableZoteroItem,
  input: ReturnType<typeof normalizeInput>,
): void {
  if (input.title) payload.title = input.title;
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
  return payload;
}

async function createItem(
  config: ResolvedWriteConfig,
  payload: EditableZoteroItem,
  fetchImpl: FetchLike,
): Promise<string> {
  const url = `${libraryBaseUrl(config)}/items`;
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: "POST",
    headers: buildHeaders(config.apiKey, { "Zotero-Write-Token": createWriteToken() }),
    body: JSON.stringify([payload]),
  });
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
    headers: buildHeaders(undefined, { Accept: "application/json" }),
  });
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
  config: ResolvedWriteConfig,
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
  config: ResolvedWriteConfig,
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

export async function addToZotero(
  input: AddInput,
  overrides: ConfigOverrides = {},
  fetchImpl: FetchLike = fetch,
): Promise<AddResult> {
  const config = resolveConfig(overrides);
  const writeConfig = getWriteConfig(config);
  const normalizedInput = normalizeInput(input);
  const warnings = [...config.warnings];
  const effectiveCollectionKey = normalizedInput.collectionKey || config.zoteroCollectionKey || "";
  const normalizedWithDefaults = {
    ...normalizedInput,
    collectionKey: effectiveCollectionKey,
  };

  if (!normalizedWithDefaults.doi && !normalizedWithDefaults.title) {
    throw new Error("Provide --doi <doi> or --title <text>.");
  }

  // Validate attach-file *before* hitting Zotero, so a bad path can't leave
  // an orphan parent item behind.
  const attach = normalizedWithDefaults.attachFile
    ? resolveAttachFile(normalizedWithDefaults.attachFile, config.attachmentsRoot)
    : undefined;

  const manualItemType = inferManualItemType({
    itemType: normalizedWithDefaults.itemType,
    publication: normalizedWithDefaults.publication,
    url: normalizedWithDefaults.url,
  });

  if (normalizedWithDefaults.doi) {
    const cleanedDoi = cleanDoi(normalizedWithDefaults.doi);
    try {
      const cslJson = await fetchCslJsonForDoi(cleanedDoi, fetchImpl);
      const itemType = normalizedWithDefaults.itemType || determineDoiItemType(cslJson);
      const template = await fetchTemplate(itemType, fetchImpl);
      const payload = buildItemFromCsl(template, cslJson, cleanedDoi);
      applyManualOverrides(payload, normalizedWithDefaults);
      const itemKey = await createItem(writeConfig, payload, fetchImpl);
      const attachmentItemKey = await maybeCreateAttachment(
        itemKey,
        attach,
        writeConfig,
        fetchImpl,
        warnings,
      );
      return {
        itemKey,
        title: typeof payload.title === "string" ? payload.title : "",
        itemType: payload.itemType,
        created: true,
        source: "doi",
        doi: cleanedDoi,
        ...(attachmentItemKey ? { attachmentItemKey } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (error) {
      if (!normalizedWithDefaults.title) {
        throw error;
      }
      warnings.push(
        `DOI import failed; created item from manual fields instead. ${error instanceof Error ? error.message : String(error)}`,
      );
      const template = await fetchTemplate(manualItemType, fetchImpl);
      const payload = buildManualItem(template, normalizedWithDefaults);
      if ("DOI" in payload) payload.DOI = cleanedDoi;
      const itemKey = await createItem(writeConfig, payload, fetchImpl);
      const attachmentItemKey = await maybeCreateAttachment(
        itemKey,
        attach,
        writeConfig,
        fetchImpl,
        warnings,
      );
      return {
        itemKey,
        title: typeof payload.title === "string" ? payload.title : "",
        itemType: payload.itemType,
        created: true,
        source: "manual-fallback",
        doi: cleanedDoi,
        ...(attachmentItemKey ? { attachmentItemKey } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }
  }

  const template = await fetchTemplate(manualItemType, fetchImpl);
  const payload = buildManualItem(template, normalizedWithDefaults);
  const itemKey = await createItem(writeConfig, payload, fetchImpl);
  const attachmentItemKey = await maybeCreateAttachment(
    itemKey,
    attach,
    writeConfig,
    fetchImpl,
    warnings,
  );
  return {
    itemKey,
    title: typeof payload.title === "string" ? payload.title : "",
    itemType: payload.itemType,
    created: true,
    source: "manual",
    ...(attachmentItemKey ? { attachmentItemKey } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
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
 *   - tags                  always appended `{tag: "Added by AI Agent"}` via
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

      const itemKey = await createItem(writeConfig, payload, fetchImpl);
      const itemWarnings = [...baseWarnings, ...input.warnings];
      const attachmentItemKey = await maybeCreateAttachment(
        itemKey,
        attach,
        writeConfig,
        fetchImpl,
        itemWarnings,
      );
      results.push({
        itemKey,
        title: typeof payload.title === "string" ? payload.title : input.title,
        itemType: typeof payload.itemType === "string" ? payload.itemType : input.itemType,
        created: true,
        source: "json",
        ...(attachmentItemKey ? { attachmentItemKey } : {}),
        ...(itemWarnings.length > 0 ? { warnings: itemWarnings } : {}),
      });
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
