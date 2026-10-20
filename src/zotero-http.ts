import { fetchWithTimeout, type FetchLike } from "./http.js";
import type { AppConfig, ZoteroLibraryType } from "./types.js";

// The Zotero Web API surface: credential resolution, URL and header
// construction, and top-level item-key resolution by tag / collection.
// Every reader and writer of api.zotero.org goes through this module.

export const ZOTERO_REQUEST_TIMEOUT_MS = 30000;

export interface ZoteroCredentials {
  apiKey: string;
  libraryId: string;
  libraryType: ZoteroLibraryType;
}

export function getReadConfig(config: AppConfig): ZoteroCredentials {
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

export function getWriteConfig(config: AppConfig): ZoteroCredentials {
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

export function libraryBaseUrl(config: Pick<ZoteroCredentials, "libraryId" | "libraryType">): string {
  const prefix = config.libraryType === "group" ? "groups" : "users";
  return `https://api.zotero.org/${prefix}/${encodeURIComponent(config.libraryId)}`;
}

/** Standard JSON headers for the Zotero Web API (v3). */
export function zoteroJsonHeaders(apiKey?: string, extra: Record<string, string> = {}): HeadersInit {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Zotero-API-Version": "3",
    ...(apiKey ? { "Zotero-API-Key": apiKey } : {}),
    ...extra,
  };
}

export function normalizeTagFilters(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
}

const COLLECTION_KEY_PATTERN = /^[A-Z0-9]{8}$/u;

export function normalizeCollectionFilters(keys: string[]): string[] {
  return [...new Set(keys.map((key) => key.trim()).filter((key) => key.length > 0))];
}

export function isValidCollectionKey(key: string): boolean {
  return COLLECTION_KEY_PATTERN.test(key);
}

// Zotero v3 returns the full key list for `format=keys` in a single
// newline-delimited response — `limit`/`start` are ignored for this format
// (https://www.zotero.org/support/dev/web_api/v3/basics). We still verify
// `Total-Results` against the parsed line count so a future API change that
// silently truncates would surface as an error instead of dropped items.
export class ZoteroLookupError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ZoteroLookupError";
  }
}

export async function fetchTopLevelItemKeysByTags(
  tags: string[],
  readConfig: ZoteroCredentials,
  fetchImpl: FetchLike = fetch,
): Promise<string[]> {
  const normalizedTags = normalizeTagFilters(tags);
  if (normalizedTags.length === 0) return [];

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
  }, ZOTERO_REQUEST_TIMEOUT_MS);
  const text = await response.text();
  if (!response.ok) {
    const detail = text.trim() || response.statusText;
    throw new Error(`Request failed (${response.status}) for ${url}: ${detail}`);
  }

  const itemKeys = text.split(/\s+/u).map((key) => key.trim()).filter((key) => key.length > 0);
  assertUnpaginatedKeys(response, itemKeys, url);
  return itemKeys;
}

export async function fetchTopLevelItemKeysByCollections(
  collectionKeys: string[],
  readConfig: ZoteroCredentials,
  fetchImpl: FetchLike = fetch,
): Promise<string[]> {
  const normalizedKeys = normalizeCollectionFilters(collectionKeys);
  if (normalizedKeys.length === 0) return [];

  const aggregated: string[] = [];
  for (const collectionKey of normalizedKeys) {
    const url = `${libraryBaseUrl(readConfig)}/collections/${encodeURIComponent(collectionKey)}/items/top?format=keys`;
    const response = await fetchWithTimeout(fetchImpl, url, {
      headers: {
        Accept: "text/plain",
        "Zotero-API-Version": "3",
        "Zotero-API-Key": readConfig.apiKey,
      },
    }, ZOTERO_REQUEST_TIMEOUT_MS);
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 404) {
        throw new ZoteroLookupError(
          "COLLECTION_NOT_FOUND",
          `Zotero collection ${collectionKey} not found (404). Verify the collection key: it is the 8-character key ` +
            "at the end of the collection's URL in the Zotero web library.",
        );
      }
      const detail = text.trim() || response.statusText;
      throw new Error(`Request failed (${response.status}) for ${url}: ${detail}`);
    }

    const itemKeys = text.split(/\s+/u).map((key) => key.trim()).filter((key) => key.length > 0);
    assertUnpaginatedKeys(response, itemKeys, url);
    aggregated.push(...itemKeys);
  }
  return [...new Set(aggregated)];
}

function assertUnpaginatedKeys(response: Response, itemKeys: string[], url: string): void {
  const totalHeader = response.headers.get("Total-Results");
  if (totalHeader === null) return;
  const total = Number.parseInt(totalHeader, 10);
  if (Number.isFinite(total) && total > itemKeys.length) {
    throw new Error(
      `Zotero returned ${itemKeys.length} of ${total} matching item keys for ${url}; ` +
        "format=keys was expected to be unpaginated. Refusing to silently drop matches.",
    );
  }
}

export interface ItemKeyFilter {
  itemKeys: string[];
  /** Why the filter matched nothing, when it did; empty otherwise. */
  warnings: string[];
}

const quoteList = (values: string[]): string => values.map((value) => `"${value}"`).join(", ");

/**
 * Resolve `--tag` / `--collection-key` filters to the top-level itemKeys that
 * satisfy BOTH (intersection when both are present). Returns undefined when
 * neither filter is given, so callers can distinguish "no filter" from
 * "filter matched nothing". A filter that matches nothing carries a warning:
 * Zotero answers a misspelled tag with an empty list, not an error, so without
 * one an agent reads "0 results" as "the library has nothing on this".
 */
export async function resolveItemKeyFilter(
  tags: string[] | undefined,
  collectionKeys: string[] | undefined,
  readConfig: ZoteroCredentials,
  fetchImpl: FetchLike = fetch,
): Promise<ItemKeyFilter | undefined> {
  const tagItemKeys = tags ? await fetchTopLevelItemKeysByTags(tags, readConfig, fetchImpl) : undefined;
  const collectionItemKeys = collectionKeys
    ? await fetchTopLevelItemKeysByCollections(collectionKeys, readConfig, fetchImpl)
    : undefined;
  if (tagItemKeys === undefined && collectionItemKeys === undefined) return undefined;

  const warnings: string[] = [];
  if (tagItemKeys !== undefined && tagItemKeys.length === 0) {
    const names = normalizeTagFilters(tags!);
    warnings.push(
      names.length === 1
        ? `No top-level item carries the tag ${quoteList(names)}. Check the spelling: Zotero matches tags exactly ` +
            "apart from case, and tags on attachments or notes do not count."
        : `No top-level item carries all of the tags ${quoteList(names)}; repeated --tag flags must all match. ` +
            "Check the spelling of each.",
    );
  }
  if (collectionItemKeys !== undefined && collectionItemKeys.length === 0) {
    const keys = normalizeCollectionFilters(collectionKeys!);
    warnings.push(
      `${keys.length === 1 ? "Collection" : "Collections"} ${quoteList(keys)} ` +
        `${keys.length === 1 ? "has" : "have"} no top-level items; items in subcollections are not included.`,
    );
  }
  let itemKeys: string[];
  if (tagItemKeys === undefined) itemKeys = collectionItemKeys!;
  else if (collectionItemKeys === undefined) itemKeys = tagItemKeys;
  else {
    const collectionSet = new Set(collectionItemKeys);
    itemKeys = tagItemKeys.filter((key) => collectionSet.has(key));
    if (itemKeys.length === 0 && warnings.length === 0) {
      warnings.push("The tag and collection filters each match items, but no top-level item matches both.");
    }
  }
  return { itemKeys, warnings };
}
