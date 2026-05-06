import {
  fetchWithTimeout,
  libraryBaseUrl,
  type FetchLike,
  type ResolvedReadConfig,
} from "./zotero-read.js";

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
export async function fetchTopLevelItemKeysByCollections(
  collectionKeys: string[],
  readConfig: ResolvedReadConfig,
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
    });
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(
          `Zotero collection ${collectionKey} not found (404). Verify the collection key in your library.`,
        );
      }
      const detail = text.trim() || response.statusText;
      throw new Error(`Request failed (${response.status}) for ${url}: ${detail}`);
    }

    const itemKeys = text.split(/\s+/u).map((key) => key.trim()).filter((key) => key.length > 0);
    const totalHeader = response.headers.get("Total-Results");
    if (totalHeader !== null) {
      const total = Number.parseInt(totalHeader, 10);
      if (Number.isFinite(total) && total > itemKeys.length) {
        throw new Error(
          `Zotero returned ${itemKeys.length} of ${total} matching item keys for ${url}; ` +
            "format=keys was expected to be unpaginated. Refusing to silently drop matches.",
        );
      }
    }
    aggregated.push(...itemKeys);
  }
  return [...new Set(aggregated)];
}
