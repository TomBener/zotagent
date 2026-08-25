import { resolveConfig, type ConfigOverrides } from "./config.js";
import { fetchWithTimeout, readJsonResponse, type FetchLike } from "./http.js";
import { cleanDoi } from "./item-metadata.js";
import type {
  AppConfig,
  SemanticScholarLinkedPaperRow,
  SemanticScholarPaper,
  SemanticScholarSearchResultRow,
} from "./types.js";

const SEMANTIC_SCHOLAR_API_BASE = "https://api.semanticscholar.org/graph/v1";
const REQUEST_TIMEOUT_MS = 8000;
const PAPER_FIELD_NAMES = [
  "title",
  "authors",
  "year",
  "externalIds",
  "publicationTypes",
  "journal",
  "url",
  "openAccessPdf",
  "publicationDate",
  "venue",
  "abstract",
];
const PAPER_FIELDS = PAPER_FIELD_NAMES.join(",");
// References/citations are a scan surface: a bibliography page can be a
// thousand rows, and abstracts would dominate the payload. Rows therefore
// drop the abstract and carry the edge-only `isInfluential` signal instead;
// `add --s2-paper-id <paperId>` fetches the full record for a chosen row.
const LINKED_PAPER_FIELDS = [
  ...PAPER_FIELD_NAMES.filter((field) => field !== "abstract"),
  "isInfluential",
].join(",");

// Semantic Scholar allows roughly one request per second across endpoints and
// answers bursts with 429. Retry a couple of times, honoring Retry-After but
// never blocking the CLI for more than 10s per wait.
const RATE_LIMIT_MAX_RETRIES = 2;
const RATE_LIMIT_MAX_WAIT_MS = 10_000;
const RATE_LIMIT_DEFAULT_WAIT_MS = 1_000;

const S2_HEX_ID_RE = /^[0-9a-f]{40}$/iu;
const PREFIXED_ID_RE = /^([A-Za-z]+):(.*)$/u;
const HTTP_URL_RE = /^https?:\/\/\S+$/iu;
const DOI_URL_RE = /^https?:\/\/(?:dx\.)?doi\.org\//iu;
const ARXIV_URL_RE = /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/(\S+?)\/?$/iu;
const SEMANTIC_SCHOLAR_URL_RE = /^https?:\/\/(?:www\.)?semanticscholar\.org\//iu;
const SEMANTIC_SCHOLAR_URL_HEX_RE = /\/([0-9a-f]{40})(?:[/?#]|$)/iu;
const BARE_ARXIV_ID_RE = /^\d{4}\.\d{4,5}(?:v\d+)?$/u;
const ARXIV_VERSION_SUFFIX_RE = /v\d+$/u;

const SUPPORTED_ID_FORMS =
  "Supported forms: a 40-character Semantic Scholar paperId, a DOI (10.x/...), an arXiv id (2106.15928), " +
  "a prefixed id (DOI:, ARXIV:, PMID:, CorpusId:, URL:), or a doi.org / arxiv.org / semanticscholar.org URL. " +
  'A title is not an identifier — run `zotagent s2 "<text>"` first and pass a returned paperId.';

export class SemanticScholarError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "SemanticScholarError";
  }
}

interface SemanticScholarAuthor {
  name?: unknown;
}

interface SemanticScholarJournal {
  name?: unknown;
}

interface SemanticScholarOpenAccessPdf {
  url?: unknown;
}

interface SemanticScholarPaperApiRow {
  paperId?: unknown;
  title?: unknown;
  authors?: unknown;
  year?: unknown;
  externalIds?: unknown;
  publicationTypes?: unknown;
  journal?: unknown;
  url?: unknown;
  openAccessPdf?: unknown;
  publicationDate?: unknown;
  venue?: unknown;
  abstract?: unknown;
}

interface SemanticScholarSearchApiResponse {
  total?: unknown;
  offset?: unknown;
  next?: unknown;
  data?: unknown;
}

interface SemanticScholarLinkApiRow {
  isInfluential?: unknown;
  citedPaper?: unknown;
  citingPaper?: unknown;
}

interface SemanticScholarLinksApiResponse {
  offset?: unknown;
  next?: unknown;
  data?: unknown;
}

function normalizeSpace(value: string): string {
  return value.replace(/\u00a0/gu, " ").replace(/\s+/gu, " ").trim();
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = normalizeSpace(value);
    return normalized || undefined;
  }
  return undefined;
}

function numberToOptionalString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `${value}`;
  }
  return firstString(value);
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => firstString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function getSemanticScholarHeaders(config: AppConfig): HeadersInit {
  return {
    Accept: "application/json",
    ...(config.semanticScholarApiKey ? { "x-api-key": config.semanticScholarApiKey } : {}),
  };
}

function extractAuthorNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      return firstString((entry as SemanticScholarAuthor).name);
    })
    .filter((name): name is string => Boolean(name));
}

function extractDoi(externalIds: unknown): string | undefined {
  if (!externalIds || typeof externalIds !== "object") return undefined;
  return firstString((externalIds as Record<string, unknown>).DOI);
}

function extractJournalName(journal: unknown): string | undefined {
  if (!journal || typeof journal !== "object") return undefined;
  return firstString((journal as SemanticScholarJournal).name);
}

function extractOpenAccessPdfUrl(openAccessPdf: unknown): string | undefined {
  if (!openAccessPdf || typeof openAccessPdf !== "object") return undefined;
  return firstString((openAccessPdf as SemanticScholarOpenAccessPdf).url);
}

// Citation-graph edges can point at stubs Semantic Scholar has no record for
// (`citedPaper: null`, or an object with neither paperId nor title). Those are
// skipped, not fatal, so the caller decides: mapPaper throws for single-paper
// and search responses, fetchPaperLinks counts and drops.
function tryMapPaper(row: SemanticScholarPaperApiRow): SemanticScholarPaper | undefined {
  const paperId = firstString(row.paperId);
  const title = firstString(row.title);
  if (!paperId || !title) return undefined;

  return {
    paperId,
    title,
    authors: extractAuthorNames(row.authors),
    ...(numberToOptionalString(row.year) ? { year: numberToOptionalString(row.year)! } : {}),
    ...(extractDoi(row.externalIds) ? { doi: extractDoi(row.externalIds)! } : {}),
    ...(firstString(row.venue) ? { venue: firstString(row.venue)! } : {}),
    ...(extractJournalName(row.journal) ? { journal: extractJournalName(row.journal)! } : {}),
    ...(firstString(row.publicationDate) ? { publicationDate: firstString(row.publicationDate)! } : {}),
    publicationTypes: toStringList(row.publicationTypes),
    ...(firstString(row.url) ? { url: firstString(row.url)! } : {}),
    ...(extractOpenAccessPdfUrl(row.openAccessPdf)
      ? { openAccessPdfUrl: extractOpenAccessPdfUrl(row.openAccessPdf)! }
      : {}),
    ...(firstString(row.abstract) ? { abstract: firstString(row.abstract)! } : {}),
  };
}

function mapPaper(row: SemanticScholarPaperApiRow): SemanticScholarPaper {
  const paper = tryMapPaper(row);
  if (!paper) {
    throw new Error("Semantic Scholar paper response did not include paperId and title.");
  }
  return paper;
}

function requireSemanticScholarConfig(config: AppConfig): void {
  if (!config.semanticScholarApiKey) {
    throw new SemanticScholarError(
      "SEMANTIC_SCHOLAR_NOT_CONFIGURED",
      "Missing Semantic Scholar API key. Set semanticScholarApiKey in ~/.zotagent/config.json or ZOTAGENT_SEMANTIC_SCHOLAR_API_KEY.",
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Retry-After is optional and may be either delta-seconds or an HTTP-date.
 *  Anything unusable falls back to a one-second wait; every wait is capped so
 *  a hostile header cannot stall the CLI. Exported for direct unit testing. */
export function parseRetryAfterMs(headerValue: string | null): number {
  const raw = (headerValue ?? "").trim();
  if (!raw) return RATE_LIMIT_DEFAULT_WAIT_MS;
  if (/^\d+$/u.test(raw)) {
    return Math.min(RATE_LIMIT_MAX_WAIT_MS, Number(raw) * 1000);
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.min(RATE_LIMIT_MAX_WAIT_MS, Math.max(0, dateMs - Date.now()));
  }
  return RATE_LIMIT_DEFAULT_WAIT_MS;
}

// Single entry point for every Semantic Scholar GET, so the 429 handling is
// uniform across search, single-paper, and citation-graph calls. Each attempt
// gets its own timeout budget; non-429 failures keep readJsonResponse's plain
// Error wording.
async function fetchSemanticScholarJson<T>(
  url: string,
  config: AppConfig,
  fetchImpl: FetchLike,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetchWithTimeout(fetchImpl, url, {
      headers: getSemanticScholarHeaders(config),
    }, REQUEST_TIMEOUT_MS);
    if (response.status !== 429) {
      return await readJsonResponse<T>(response, url);
    }
    // Drain the throttle body so the connection can be reused.
    await response.text().catch(() => "");
    if (attempt >= RATE_LIMIT_MAX_RETRIES) {
      throw new SemanticScholarError(
        "RATE_LIMITED",
        `Semantic Scholar rate-limited this request (HTTP 429) after ${RATE_LIMIT_MAX_RETRIES + 1} attempts. ` +
          "The API allows about one request per second across all endpoints — wait a moment, retry, and never run Semantic Scholar calls in parallel.",
        { url },
      );
    }
    await sleep(parseRetryAfterMs(response.headers.get("retry-after")));
  }
}

// Semantic Scholar addresses papers by prefixed identifiers whose payload can
// itself contain '/' and ':' (DOI:10.1093/ajae/aaq063). Percent-encode the id
// for safety, then put those two separators back so the path stays the literal
// form the API expects.
function encodeS2IdPath(id: string): string {
  return encodeURIComponent(id).replace(/%2F/gu, "/").replace(/%3A/gu, ":");
}

function invalidPaperId(raw: string, detail?: string): SemanticScholarError {
  return new SemanticScholarError(
    "INVALID_ARGUMENT",
    `Unrecognized paper identifier: ${raw}.${detail ? ` ${detail}` : ""} ${SUPPORTED_ID_FORMS}`,
  );
}

function toDoiPaperId(candidate: string, raw: string): string {
  try {
    return `DOI:${cleanDoi(candidate)}`;
  } catch {
    throw invalidPaperId(raw, "That is not a valid DOI.");
  }
}

/** Turn whatever identifier an agent has at hand into the exact string the
 *  Semantic Scholar graph API accepts. Pure and total: it either returns a
 *  canonical id or throws SemanticScholarError("INVALID_ARGUMENT"), so callers
 *  can validate before spending a network round trip. Shared by s2-refs,
 *  s2-citations, and `add --s2-paper-id`. */
export function normalizeS2PaperId(raw: string): string {
  const value = normalizeSpace(raw ?? "");
  if (!value) {
    throw new SemanticScholarError(
      "INVALID_ARGUMENT",
      `Missing paper identifier. ${SUPPORTED_ID_FORMS}`,
    );
  }

  if (S2_HEX_ID_RE.test(value)) return value.toLowerCase();

  const prefixed = PREFIXED_ID_RE.exec(value);
  const prefix = prefixed ? prefixed[1]!.toUpperCase() : undefined;
  const payload = prefixed ? prefixed[2]!.trim() : "";

  if (prefix === "DOI") return toDoiPaperId(payload, value);
  if (prefix === "ARXIV") {
    // Strip the version suffix like the URL and bare forms do: Semantic
    // Scholar indexes arXiv papers by unversioned id.
    const arxivId = payload.replace(ARXIV_VERSION_SUFFIX_RE, "");
    if (!arxivId) throw invalidPaperId(value, "ARXIV: needs an arXiv id.");
    return `ARXIV:${arxivId}`;
  }
  if (prefix === "PMID" || prefix === "CORPUSID") {
    const canonical = prefix === "PMID" ? "PMID" : "CorpusId";
    if (!/^\d+$/u.test(payload)) {
      throw invalidPaperId(value, `${canonical}: takes digits only.`);
    }
    return `${canonical}:${payload}`;
  }
  if (prefix === "URL") {
    if (!HTTP_URL_RE.test(payload)) {
      throw invalidPaperId(value, "URL: takes an http(s) URL.");
    }
    return `URL:${payload}`;
  }

  // URL forms are decided here rather than by the generic prefix passthrough
  // below, which would otherwise swallow every "https:..." string.
  if (HTTP_URL_RE.test(value)) {
    // DOI and arXiv ids never carry a query string or fragment — that is
    // browser junk (?download=true, #section) that would otherwise leak into
    // the identifier and 404 after spending a rate-limited request.
    const withoutQuery = value.replace(/[?#].*$/u, "");
    if (DOI_URL_RE.test(withoutQuery)) return toDoiPaperId(withoutQuery, value);
    const arxivUrl = ARXIV_URL_RE.exec(withoutQuery);
    if (arxivUrl) {
      const arxivId = arxivUrl[1]!
        .replace(/\.pdf$/iu, "")
        .replace(ARXIV_VERSION_SUFFIX_RE, "");
      if (!arxivId) throw invalidPaperId(value, "That arxiv.org URL has no arXiv id.");
      return `ARXIV:${arxivId}`;
    }
    if (SEMANTIC_SCHOLAR_URL_RE.test(value)) {
      const hex = SEMANTIC_SCHOLAR_URL_HEX_RE.exec(value);
      if (hex) return hex[1]!.toLowerCase();
      return `URL:${value}`;
    }
    throw invalidPaperId(value, "Pass an indexed page explicitly as URL:<url>.");
  }

  // Any other prefixed form (MAG:, ACL:, PMCID:, …) goes through with only
  // the payload trimmed, exactly like the known prefixes above: Semantic
  // Scholar owns the list and validates it server-side.
  if (prefixed && /^\S+$/u.test(payload)) return `${prefixed[1]}:${payload}`;

  if (/^10\./u.test(value)) return toDoiPaperId(value, value);
  if (BARE_ARXIV_ID_RE.test(value)) {
    return `ARXIV:${value.replace(ARXIV_VERSION_SUFFIX_RE, "")}`;
  }

  throw invalidPaperId(value);
}

async function fetchPaper(
  paperId: string,
  config: AppConfig,
  fetchImpl: FetchLike,
): Promise<SemanticScholarPaper> {
  requireSemanticScholarConfig(config);
  const url = new URL(`${SEMANTIC_SCHOLAR_API_BASE}/paper/${encodeS2IdPath(paperId)}`);
  url.searchParams.set("fields", PAPER_FIELDS);

  return mapPaper(
    await fetchSemanticScholarJson<SemanticScholarPaperApiRow>(url.toString(), config, fetchImpl),
  );
}

export function inferSemanticScholarItemType(paper: SemanticScholarPaper): string | undefined {
  const normalizedTypes = new Set(paper.publicationTypes.map((entry) => entry.toLowerCase()));
  if (normalizedTypes.has("journalarticle") || paper.journal) return "journalArticle";
  if (normalizedTypes.has("conference") || normalizedTypes.has("conferencepaper")) return "conferencePaper";
  if (normalizedTypes.has("book")) return "book";
  if (normalizedTypes.has("booksection") || normalizedTypes.has("chapter")) return "bookSection";
  if (normalizedTypes.has("thesis")) return "thesis";
  if (normalizedTypes.has("report")) return "report";
  if (normalizedTypes.has("preprint")) return "preprint";
  return undefined;
}

export interface SemanticScholarSearchOptions {
  limit: number;
  offset?: number;
  year?: string;
}

export async function searchSemanticScholar(
  query: string,
  options: SemanticScholarSearchOptions,
  overrides: ConfigOverrides = {},
  fetchImpl: FetchLike = fetch,
): Promise<{
  total?: number;
  offset?: number;
  next?: number;
  results: SemanticScholarSearchResultRow[];
  warnings?: string[];
}> {
  const config = resolveConfig(overrides);
  requireSemanticScholarConfig(config);

  const normalizedQuery = normalizeSpace(query);
  if (!normalizedQuery) {
    throw new Error("Semantic Scholar search text cannot be empty.");
  }

  const url = new URL(`${SEMANTIC_SCHOLAR_API_BASE}/paper/search`);
  url.searchParams.set("query", normalizedQuery);
  url.searchParams.set("limit", `${options.limit}`);
  if (options.offset !== undefined) url.searchParams.set("offset", `${options.offset}`);
  if (options.year) url.searchParams.set("year", options.year);
  url.searchParams.set("fields", PAPER_FIELDS);

  const data = await fetchSemanticScholarJson<SemanticScholarSearchApiResponse>(
    url.toString(),
    config,
    fetchImpl,
  );
  const rows = Array.isArray(data.data) ? data.data : [];
  // Degenerate rows (no paperId or title) are skipped, not fatal, matching
  // fetchPaperLinks: nine good results plus a warning beat a dead command.
  const results: SemanticScholarSearchResultRow[] = [];
  let skipped = 0;
  for (const row of rows) {
    const paper = tryMapPaper((row || {}) as SemanticScholarPaperApiRow);
    if (!paper) {
      skipped += 1;
      continue;
    }
    results.push(paper);
  }

  const warnings = [
    ...config.warnings,
    ...(skipped > 0 ? [`Skipped ${skipped} entries with no Semantic Scholar record.`] : []),
  ];

  return {
    ...(typeof data.total === "number" ? { total: data.total } : {}),
    ...(typeof data.offset === "number" ? { offset: data.offset } : {}),
    ...(typeof data.next === "number" ? { next: data.next } : {}),
    results,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export interface SemanticScholarLinksOptions {
  limit: number;
  offset: number;
}

export interface SemanticScholarLinksResult {
  /** The normalized identifier the request was made with, echoed back so a
   *  chained call does not have to re-derive it. */
  paperId: string;
  offset?: number;
  next?: number;
  results: SemanticScholarLinkedPaperRow[];
  warnings?: string[];
}

async function fetchPaperLinks(
  direction: "references" | "citations",
  paperId: string,
  options: SemanticScholarLinksOptions,
  overrides: ConfigOverrides,
  fetchImpl: FetchLike,
): Promise<SemanticScholarLinksResult> {
  const config = resolveConfig(overrides);
  requireSemanticScholarConfig(config);

  const url = new URL(
    `${SEMANTIC_SCHOLAR_API_BASE}/paper/${encodeS2IdPath(paperId)}/${direction}`,
  );
  url.searchParams.set("offset", `${options.offset}`);
  url.searchParams.set("limit", `${options.limit}`);
  url.searchParams.set("fields", LINKED_PAPER_FIELDS);

  const data = await fetchSemanticScholarJson<SemanticScholarLinksApiResponse>(
    url.toString(),
    config,
    fetchImpl,
  );
  const rows = Array.isArray(data.data) ? data.data : [];
  const results: SemanticScholarLinkedPaperRow[] = [];
  let skipped = 0;
  for (const row of rows) {
    const edge = (row || {}) as SemanticScholarLinkApiRow;
    const linked = direction === "references" ? edge.citedPaper : edge.citingPaper;
    const paper = tryMapPaper((linked || {}) as SemanticScholarPaperApiRow);
    if (!paper) {
      skipped += 1;
      continue;
    }
    // The abstract is dropped structurally, not just left out of `fields`:
    // the row contract promises a compact scan surface either way.
    const { abstract: _abstract, ...linkedRow } = paper;
    results.push({
      ...linkedRow,
      ...(edge.isInfluential === true ? { isInfluential: true } : {}),
    });
  }

  const warnings = [
    ...config.warnings,
    ...(skipped > 0 ? [`Skipped ${skipped} entries with no Semantic Scholar record.`] : []),
  ];

  return {
    paperId,
    ...(typeof data.offset === "number" ? { offset: data.offset } : {}),
    ...(typeof data.next === "number" ? { next: data.next } : {}),
    results,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** The papers a work cites — its bibliography, as Semantic Scholar resolved it. */
export function getSemanticScholarReferences(
  paperId: string,
  options: SemanticScholarLinksOptions,
  overrides: ConfigOverrides = {},
  fetchImpl: FetchLike = fetch,
): Promise<SemanticScholarLinksResult> {
  return fetchPaperLinks("references", paperId, options, overrides, fetchImpl);
}

/** The papers that cite a work — forward citation chaining. */
export function getSemanticScholarCitations(
  paperId: string,
  options: SemanticScholarLinksOptions,
  overrides: ConfigOverrides = {},
  fetchImpl: FetchLike = fetch,
): Promise<SemanticScholarLinksResult> {
  return fetchPaperLinks("citations", paperId, options, overrides, fetchImpl);
}

export async function getSemanticScholarPaper(
  paperId: string,
  overrides: ConfigOverrides = {},
  fetchImpl: FetchLike = fetch,
): Promise<{
  paper: SemanticScholarPaper;
  warnings?: string[];
}> {
  const config = resolveConfig(overrides);
  const paper = await fetchPaper(paperId, config, fetchImpl);

  return {
    paper,
    ...(config.warnings.length > 0 ? { warnings: config.warnings } : {}),
  };
}
