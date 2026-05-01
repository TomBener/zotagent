import { resolveConfig, type ConfigOverrides } from "./config.js";
import type { AppConfig, ZoteroLibraryType } from "./types.js";

type FetchLike = typeof fetch;

const REQUEST_TIMEOUT_MS = 30000;

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

export function normalizeTagFilters(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
}

export async function fetchTopLevelItemKeysByTags(
  tags: string[],
  overrides: ConfigOverrides = {},
  fetchImpl: FetchLike = fetch,
): Promise<{ itemKeys: string[]; warnings?: string[] }> {
  const normalizedTags = normalizeTagFilters(tags);
  if (normalizedTags.length === 0) {
    return { itemKeys: [] };
  }

  const config = resolveConfig(overrides);
  const readConfig = getReadConfig(config);
  const params = new URLSearchParams({ format: "keys" });
  for (const tag of normalizedTags) {
    params.append("tag", tag);
  }

  const url = `${libraryBaseUrl(readConfig)}/items/top?${params.toString()}`;
  const response = await fetchWithTimeout(fetchImpl, url, {
    headers: {
      Accept: "text/plain",
      "Zotero-API-Version": "3",
      "Zotero-API-Key": readConfig.apiKey,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    const detail = text.trim() || response.statusText;
    throw new Error(`Request failed (${response.status}) for ${url}: ${detail}`);
  }

  return {
    itemKeys: text.split(/\s+/u).map((key) => key.trim()).filter((key) => key.length > 0),
    ...(config.warnings.length > 0 ? { warnings: config.warnings } : {}),
  };
}
