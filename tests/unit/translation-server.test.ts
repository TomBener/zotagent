import test from "node:test";
import assert from "node:assert/strict";

import {
  searchByIdentifier,
  translateWebUrl,
  TranslationServerError,
} from "../../src/translation-server.js";

const SERVER = "http://127.0.0.1:1969";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RecordedRequest {
  url: string;
  init?: RequestInit;
}

function recordingFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetchMock: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    return handler(url, init);
  };
  return { fetchMock, requests };
}

test("translateWebUrl posts the page URL as text/plain and returns items", async () => {
  const item = { itemType: "webpage", title: "Example", url: "https://example.com" };
  const { fetchMock, requests } = recordingFetch(() => jsonResponse([item]));

  const outcome = await translateWebUrl(SERVER, "https://example.com", undefined, fetchMock);

  assert.equal(outcome.kind, "items");
  assert.deepEqual(outcome.kind === "items" && outcome.items, [item]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${SERVER}/web`);
  assert.equal(requests[0].init?.method, "POST");
  assert.equal(String(requests[0].init?.body), "https://example.com");
  assert.equal(
    (requests[0].init?.headers as Record<string, string>)["Content-Type"],
    "text/plain",
  );
});

test("translateWebUrl wraps a single-object response in an array", async () => {
  const item = { itemType: "webpage", title: "Single" };
  const { fetchMock } = recordingFetch(() => jsonResponse(item));

  const outcome = await translateWebUrl(SERVER, "https://example.com", undefined, fetchMock);

  assert.equal(outcome.kind, "items");
  assert.deepEqual(outcome.kind === "items" && outcome.items, [item]);
});

test("translateWebUrl surfaces 300 multiple-candidate responses as choices", async () => {
  const { fetchMock } = recordingFetch(() =>
    jsonResponse(
      {
        url: "https://example.com/search",
        session: "session-1",
        items: {
          "0": "Plain Title",
          "1": { title: "Object Title" },
        },
      },
      300,
    ),
  );

  const outcome = await translateWebUrl(SERVER, "https://example.com/search", undefined, fetchMock);

  assert.equal(outcome.kind, "choices");
  assert.deepEqual(outcome.kind === "choices" && outcome.choices, [
    { key: "0", title: "Plain Title" },
    { key: "1", title: "Object Title" },
  ]);
});

test("translateWebUrl with select re-posts the chosen candidate on the same session", async () => {
  const selectedItem = { itemType: "journalArticle", title: "Picked" };
  const { fetchMock, requests } = recordingFetch((url, init) => {
    const contentType = (init?.headers as Record<string, string>)["Content-Type"];
    if (contentType === "text/plain") {
      return jsonResponse(
        {
          url: "https://example.com/search",
          session: "session-2",
          items: { a1: "First", b2: "Second" },
        },
        300,
      );
    }
    return jsonResponse([selectedItem]);
  });

  const outcome = await translateWebUrl(SERVER, "https://example.com/search", "b2", fetchMock);

  assert.equal(outcome.kind, "items");
  assert.deepEqual(outcome.kind === "items" && outcome.items, [selectedItem]);
  assert.equal(requests.length, 2);
  const followUp = JSON.parse(String(requests[1].init?.body)) as Record<string, unknown>;
  assert.equal(requests[1].url, `${SERVER}/web`);
  assert.equal(
    (requests[1].init?.headers as Record<string, string>)["Content-Type"],
    "application/json",
  );
  assert.equal(followUp.session, "session-2");
  assert.deepEqual(followUp.items, { b2: "Second" });
});

test("translateWebUrl rejects an unknown select key with the valid choices", async () => {
  const { fetchMock, requests } = recordingFetch(() =>
    jsonResponse(
      { url: "https://example.com/s", session: "s", items: { x: "Only" } },
      300,
    ),
  );

  await assert.rejects(
    translateWebUrl(SERVER, "https://example.com/s", "nope", fetchMock),
    (error: unknown) => {
      assert.ok(error instanceof TranslationServerError);
      assert.equal(error.code, "INVALID_SELECT_KEY");
      assert.match(error.message, /Valid keys: x/u);
      assert.deepEqual(error.details, { choices: [{ key: "x", title: "Only" }] });
      return true;
    },
  );
  // No follow-up POST happened for an invalid key.
  assert.equal(requests.length, 1);
});

test("translateWebUrl maps 501 to TRANSLATION_NO_ITEMS", async () => {
  const { fetchMock } = recordingFetch(
    () => new Response("No translators available", { status: 501 }),
  );

  await assert.rejects(
    translateWebUrl(SERVER, "https://example.com/none", undefined, fetchMock),
    (error: unknown) => {
      assert.ok(error instanceof TranslationServerError);
      assert.equal(error.code, "TRANSLATION_NO_ITEMS");
      assert.match(error.message, /No translator produced items/u);
      return true;
    },
  );
});

test("translateWebUrl maps other failures to TRANSLATION_FAILED with a body snippet", async () => {
  const { fetchMock } = recordingFetch(
    () => new Response("An error occurred during translation", { status: 500 }),
  );

  await assert.rejects(
    translateWebUrl(SERVER, "https://example.com/broken", undefined, fetchMock),
    (error: unknown) => {
      assert.ok(error instanceof TranslationServerError);
      assert.equal(error.code, "TRANSLATION_FAILED");
      assert.match(error.message, /\(500\)/u);
      assert.match(error.message, /An error occurred during translation/u);
      return true;
    },
  );
});

test("translateWebUrl rejects a non-JSON success body", async () => {
  const { fetchMock } = recordingFetch(() => new Response("<html>nope</html>", { status: 200 }));

  await assert.rejects(
    translateWebUrl(SERVER, "https://example.com", undefined, fetchMock),
    (error: unknown) => {
      assert.ok(error instanceof TranslationServerError);
      assert.equal(error.code, "TRANSLATION_FAILED");
      assert.match(error.message, /non-JSON response/u);
      return true;
    },
  );
});

test("network failures surface as TRANSLATION_SERVER_UNREACHABLE with a docker hint", async () => {
  const fetchMock: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };

  await assert.rejects(
    translateWebUrl(SERVER, "https://example.com", undefined, fetchMock),
    (error: unknown) => {
      assert.ok(error instanceof TranslationServerError);
      assert.equal(error.code, "TRANSLATION_SERVER_UNREACHABLE");
      assert.match(error.message, /docker run -d -p 1969:1969 zotero\/translation-server/u);
      return true;
    },
  );
});

test("searchByIdentifier posts the identifier as text/plain and returns items", async () => {
  const item = { itemType: "book", title: "A Book", ISBN: "9780000000000" };
  const { fetchMock, requests } = recordingFetch(() => jsonResponse([item]));

  const items = await searchByIdentifier(SERVER, " 9780000000000 ", fetchMock);

  assert.deepEqual(items, [item]);
  assert.equal(requests[0].url, `${SERVER}/search`);
  assert.equal(String(requests[0].init?.body), "9780000000000");
  assert.equal(
    (requests[0].init?.headers as Record<string, string>)["Content-Type"],
    "text/plain",
  );
});

test("searchByIdentifier maps unresolvable identifiers to IDENTIFIER_NOT_FOUND", async () => {
  const { fetchMock } = recordingFetch(
    () => new Response("No items returned from any translator", { status: 501 }),
  );

  await assert.rejects(
    searchByIdentifier(SERVER, "10.0000/does-not-exist", fetchMock),
    (error: unknown) => {
      assert.ok(error instanceof TranslationServerError);
      assert.equal(error.code, "IDENTIFIER_NOT_FOUND");
      assert.match(error.message, /DOI, ISBN, PMID, arXiv ID/u);
      return true;
    },
  );
});

test("searchByIdentifier rejects an empty identifier without a request", async () => {
  const { fetchMock, requests } = recordingFetch(() => jsonResponse([]));

  await assert.rejects(
    searchByIdentifier(SERVER, "   ", fetchMock),
    (error: unknown) => {
      assert.ok(error instanceof TranslationServerError);
      assert.equal(error.code, "INVALID_IDENTIFIER");
      return true;
    },
  );
  assert.equal(requests.length, 0);
});
