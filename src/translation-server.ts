// HTTP client for a Zotero translation-server instance
// (https://github.com/zotero/translation-server) — the official headless
// runtime for the same site translators the Zotero browser connector uses.
// This module is transport-only: it returns raw Zotero-API-JSON items and
// leaves template gating / item creation to add.ts.

type FetchLike = typeof fetch;

// Translation is slower than a plain API call: the server fetches the remote
// page and runs translators against it. 30s mirrors the connector's patience.
const TRANSLATION_TIMEOUT_MS = 30_000;
const BODY_SNIPPET_LIMIT = 300;

export class TranslationServerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "TranslationServerError";
  }
}

/** One raw item in Zotero API JSON format, exactly as the server returned it. */
export type TranslationItem = Record<string, unknown>;

export interface TranslationChoice {
  key: string;
  title: string;
}

export type WebTranslationOutcome =
  | { kind: "items"; items: TranslationItem[] }
  | { kind: "choices"; choices: TranslationChoice[] };

function snippet(text: string): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  if (compact.length <= BODY_SNIPPET_LIMIT) return compact;
  return `${compact.slice(0, BODY_SNIPPET_LIMIT)}…`;
}

async function postToServer(
  serverUrl: string,
  path: string,
  body: string,
  contentType: string,
  fetchImpl: FetchLike,
): Promise<Response> {
  const url = `${serverUrl}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSLATION_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof TranslationServerError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new TranslationServerError(
        "TRANSLATION_TIMEOUT",
        `Translation request timed out after ${TRANSLATION_TIMEOUT_MS}ms for ${url}.`,
      );
    }
    throw new TranslationServerError(
      "TRANSLATION_SERVER_UNREACHABLE",
      `Could not reach the Zotero translation server at ${serverUrl}. ` +
        `Start one with \`docker run -d -p 1969:1969 zotero/translation-server\` ` +
        `or fix translationServerUrl in ~/.zotagent/config.json.`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function parseJson(text: string, endpoint: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new TranslationServerError(
      "TRANSLATION_FAILED",
      `Translation server returned a non-JSON response from ${endpoint}: ${snippet(text) || "(empty body)"}`,
    );
  }
}

function parseItems(text: string, endpoint: string): TranslationItem[] {
  const parsed = parseJson(text, endpoint);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const items = list.filter(
    (entry): entry is TranslationItem => typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
  if (items.length === 0) {
    throw new TranslationServerError(
      "TRANSLATION_NO_ITEMS",
      `Translation server returned no items from ${endpoint}.`,
    );
  }
  return items;
}

function httpError(endpoint: string, status: number, body: string): TranslationServerError {
  return new TranslationServerError(
    "TRANSLATION_FAILED",
    `Translation server request failed (${status}) for ${endpoint}: ${snippet(body) || "no response body"}`,
  );
}

function choiceTitle(value: unknown, key: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const title = (value as { title?: unknown }).title;
    if (typeof title === "string" && title.trim()) return title.trim();
  }
  return key;
}

/**
 * Translate a web page via POST /web. A 200 returns the translated item(s);
 * a 300 means the page lists multiple candidate items (e.g. a search results
 * or table-of-contents page). Without `select` the 300 candidates are
 * returned as `{kind: "choices"}` for the caller to surface; with `select`
 * the chosen candidate is posted back on the same server session and the
 * resulting items are returned.
 */
export async function translateWebUrl(
  serverUrl: string,
  pageUrl: string,
  select: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<WebTranslationOutcome> {
  const response = await postToServer(serverUrl, "/web", pageUrl, "text/plain", fetchImpl);
  const text = await response.text();

  if (response.status === 300) {
    const parsed = parseJson(text, "/web") as {
      url?: unknown;
      session?: unknown;
      items?: unknown;
    };
    const itemsMap =
      parsed.items && typeof parsed.items === "object" && !Array.isArray(parsed.items)
        ? (parsed.items as Record<string, unknown>)
        : {};
    const choices = Object.entries(itemsMap).map(([key, value]) => ({
      key,
      title: choiceTitle(value, key),
    }));
    if (choices.length === 0) {
      throw new TranslationServerError(
        "TRANSLATION_NO_ITEMS",
        `Translation server reported multiple results for ${pageUrl} but listed no candidates.`,
      );
    }
    if (!select) {
      return { kind: "choices", choices };
    }
    if (!(select in itemsMap)) {
      throw new TranslationServerError(
        "INVALID_SELECT_KEY",
        `--select key '${select}' is not one of the candidates for ${pageUrl}. Valid keys: ${choices
          .map((choice) => choice.key)
          .join(", ")}`,
        { choices },
      );
    }
    const followUp = JSON.stringify({
      url: typeof parsed.url === "string" ? parsed.url : pageUrl,
      session: parsed.session,
      items: { [select]: itemsMap[select] },
    });
    const selected = await postToServer(serverUrl, "/web", followUp, "application/json", fetchImpl);
    const selectedText = await selected.text();
    if (!selected.ok) throw httpError("/web", selected.status, selectedText);
    return { kind: "items", items: parseItems(selectedText, "/web") };
  }

  if (!response.ok) {
    if (response.status === 501) {
      throw new TranslationServerError(
        "TRANSLATION_NO_ITEMS",
        `No translator produced items for ${pageUrl}: ${snippet(text) || "translation returned nothing"}`,
      );
    }
    throw httpError("/web", response.status, text);
  }
  return { kind: "items", items: parseItems(text, "/web") };
}

/**
 * Resolve an identifier (DOI, ISBN, PMID, or arXiv ID) via POST /search.
 * Returns the translated item(s) in Zotero API JSON format.
 */
export async function searchByIdentifier(
  serverUrl: string,
  identifier: string,
  fetchImpl: FetchLike = fetch,
): Promise<TranslationItem[]> {
  const trimmed = identifier.trim();
  if (!trimmed) {
    throw new TranslationServerError("INVALID_IDENTIFIER", "Identifier is empty.");
  }
  const response = await postToServer(serverUrl, "/search", trimmed, "text/plain", fetchImpl);
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 400 || response.status === 501) {
      throw new TranslationServerError(
        "IDENTIFIER_NOT_FOUND",
        `Translation server could not resolve '${trimmed}' (${response.status}): ${
          snippet(text) || "no translator result"
        }. Supported identifiers: DOI, ISBN, PMID, arXiv ID.`,
      );
    }
    throw httpError("/search", response.status, text);
  }
  return parseItems(text, "/search");
}
