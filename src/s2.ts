import { resolveConfig, type ConfigOverrides } from "./config.js";
import type { AppConfig, SemanticScholarPaper, SemanticScholarSearchResultRow } from "./types.js";

const SEMANTIC_SCHOLAR_API_BASE = "https://api.semanticscholar.org/graph/v1";
const REQUEST_TIMEOUT_MS = 8000;
const PAPER_FIELDS = [
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
].join(",");

type FetchLike = typeof fetch;

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

function mapPaper(row: SemanticScholarPaperApiRow): SemanticScholarPaper {
  const paperId = firstString(row.paperId);
  const title = firstString(row.title);
  if (!paperId || !title) {
    throw new Error("Semantic Scholar paper response did not include paperId and title.");
  }

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

function requireSemanticScholarConfig(config: AppConfig): void {
  if (!config.semanticScholarApiKey) {
    throw new Error(
      "Missing Semantic Scholar API key. Set semanticScholarApiKey in ~/.zotagent/config.json or ZOTAGENT_SEMANTIC_SCHOLAR_API_KEY.",
    );
  }
}

async function fetchPaper(
  paperId: string,
  config: AppConfig,
  fetchImpl: FetchLike,
): Promise<SemanticScholarPaper> {
  requireSemanticScholarConfig(config);
  const url = new URL(`${SEMANTIC_SCHOLAR_API_BASE}/paper/${encodeURIComponent(paperId)}`);
  url.searchParams.set("fields", PAPER_FIELDS);

  const response = await fetchWithTimeout(fetchImpl, url.toString(), {
    headers: getSemanticScholarHeaders(config),
  });
  return mapPaper(await readJsonResponse<SemanticScholarPaperApiRow>(response, url.toString()));
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

export async function searchSemanticScholar(
  query: string,
  limit: number,
  overrides: ConfigOverrides = {},
  fetchImpl: FetchLike = fetch,
): Promise<{
  total?: number;
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
  url.searchParams.set("limit", `${limit}`);
  url.searchParams.set("fields", PAPER_FIELDS);

  const response = await fetchWithTimeout(fetchImpl, url.toString(), {
    headers: getSemanticScholarHeaders(config),
  });
  const data = await readJsonResponse<SemanticScholarSearchApiResponse>(response, url.toString());
  const rows = Array.isArray(data.data) ? data.data : [];
  const results = rows.map((row) => mapPaper((row || {}) as SemanticScholarPaperApiRow));

  return {
    ...(typeof data.total === "number" ? { total: data.total } : {}),
    results,
    ...(config.warnings.length > 0 ? { warnings: config.warnings } : {}),
  };
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
