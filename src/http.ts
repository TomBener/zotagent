// Generic HTTP primitives shared by every network client (Zotero Web API,
// doi.org, Semantic Scholar, translation-server callers). Timeouts are
// deliberately explicit: each caller owns its own budget.

export type FetchLike = typeof fetch;

// Statuses whose Response may not carry a body (the constructor throws).
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** Read the whole body while the caller's timeout is still armed, and hand
 *  back an equivalent Response. A server that sends headers and then stalls
 *  would otherwise hang the caller: the budget has to cover the body, not
 *  just the headers. */
export async function bufferResponse(response: Response): Promise<Response> {
  const body = await response.text();
  return new Response(NULL_BODY_STATUSES.has(response.status) ? null : body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await bufferResponse(await fetchImpl(input, { ...init, signal: controller.signal }));
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms for ${input}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function readJsonResponse<T>(response: Response, url: string): Promise<T> {
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
