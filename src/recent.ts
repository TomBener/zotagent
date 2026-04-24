import { resolveConfig, type ConfigOverrides } from "./config.js";
import type { AppConfig, ZoteroLibraryType } from "./types.js";

type FetchLike = typeof fetch;
const REQUEST_TIMEOUT_MS = 30000;

export type RecentSort = "dateAdded" | "dateModified";

export interface RecentItemRow {
  itemKey: string;
  title: string;
  authors: string[];
  year?: string;
  type: string;
  dateAdded: string;
  dateModified: string;
}

interface ZoteroCreatorResponse {
  firstName?: string;
  lastName?: string;
  name?: string;
}

interface ZoteroItemResponse {
  data: {
    key: string;
    itemType: string;
    title?: string;
    creators?: ZoteroCreatorResponse[];
    date?: string;
    dateAdded: string;
    dateModified: string;
  };
  meta?: {
    parsedDate?: string;
  };
}

interface ResolvedReadConfig {
  apiKey: string;
  libraryId: string;
  libraryType: ZoteroLibraryType;
}

function getReadConfig(config: AppConfig): ResolvedReadConfig {
  if (!config.zoteroLibraryId || !config.zoteroApiKey || !config.zoteroLibraryType) {
    throw new Error(
      "Missing Zotero read config. Set zoteroLibraryId, zoteroLibraryType, and zoteroApiKey in ~/.zotagent/config.json or ZOTAGENT_ZOTERO_* environment variables.",
    );
  }
  return {
    apiKey: config.zoteroApiKey,
    libraryId: config.zoteroLibraryId,
    libraryType: config.zoteroLibraryType,
  };
}

function libraryBaseUrl(config: ResolvedReadConfig): string {
  const prefix = config.libraryType === "group" ? "groups" : "users";
  return `https://api.zotero.org/${prefix}/${encodeURIComponent(config.libraryId)}`;
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
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms for ${input}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function formatAuthor(creator: ZoteroCreatorResponse): string | null {
  const name = (creator.name ?? "").trim();
  if (name) return name;
  const first = (creator.firstName ?? "").trim();
  const last = (creator.lastName ?? "").trim();
  if (first && last) return `${first} ${last}`;
  return last || first || null;
}

function extractYear(parsedDate: string | undefined, rawDate: string | undefined): string | undefined {
  for (const candidate of [parsedDate, rawDate]) {
    if (!candidate) continue;
    const match = candidate.match(/\d{4}/u);
    if (match) return match[0];
  }
  return undefined;
}

function toRow(item: ZoteroItemResponse): RecentItemRow {
  const authors = (item.data.creators ?? [])
    .map(formatAuthor)
    .filter((author): author is string => author !== null);
  const year = extractYear(item.meta?.parsedDate, item.data.date);
  return {
    itemKey: item.data.key,
    title: (item.data.title ?? "").trim(),
    authors,
    ...(year ? { year } : {}),
    type: item.data.itemType,
    dateAdded: item.data.dateAdded,
    dateModified: item.data.dateModified,
  };
}

export async function listRecentItems(
  options: { limit: number; sort: RecentSort },
  overrides: ConfigOverrides = {},
  fetchImpl: FetchLike = fetch,
): Promise<{ results: RecentItemRow[]; warnings?: string[] }> {
  const config = resolveConfig(overrides);
  const readConfig = getReadConfig(config);
  const params = new URLSearchParams({
    sort: options.sort,
    direction: "desc",
    limit: String(options.limit),
  });
  const url = `${libraryBaseUrl(readConfig)}/items/top?${params.toString()}`;
  const response = await fetchWithTimeout(fetchImpl, url, {
    headers: {
      Accept: "application/json",
      "Zotero-API-Version": "3",
      "Zotero-API-Key": readConfig.apiKey,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    const detail = text.trim() || response.statusText;
    throw new Error(`Request failed (${response.status}) for ${url}: ${detail}`);
  }
  if (!text.trim()) {
    throw new Error(`Expected JSON response from ${url}`);
  }
  const items = JSON.parse(text) as ZoteroItemResponse[];
  const results = items.map(toRow);
  return {
    results,
    ...(config.warnings.length > 0 ? { warnings: config.warnings } : {}),
  };
}
