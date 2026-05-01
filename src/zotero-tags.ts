import {
  fetchWithTimeout,
  libraryBaseUrl,
  type FetchLike,
  type ResolvedReadConfig,
} from "./zotero-read.js";

export function normalizeTagFilters(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
}

// Zotero v3 returns the full key list for `format=keys` in a single
// newline-delimited response — `limit`/`start` are ignored for this format
// (https://www.zotero.org/support/dev/web_api/v3/basics). We still verify
// `Total-Results` against the parsed line count so a future API change that
// silently truncates would surface as an error instead of dropped items.
export async function fetchTopLevelItemKeysByTags(
  tags: string[],
  readConfig: ResolvedReadConfig,
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
  });
  const text = await response.text();
  if (!response.ok) {
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
  return itemKeys;
}
