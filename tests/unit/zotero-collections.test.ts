import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchTopLevelItemKeysByCollections,
  isValidCollectionKey,
  normalizeCollectionFilters,
} from "../../src/zotero-collections.js";
import type { ResolvedReadConfig } from "../../src/zotero-read.js";

const userReadConfig: ResolvedReadConfig = {
  apiKey: "secret",
  libraryId: "123456",
  libraryType: "user",
};

const groupReadConfig: ResolvedReadConfig = {
  apiKey: "secret",
  libraryId: "7890",
  libraryType: "group",
};

test("normalizeCollectionFilters trims, drops blanks, and deduplicates keys", () => {
  assert.deepEqual(
    normalizeCollectionFilters([" ABCD1234 ", "", "ABCD1234", "EFGH5678"]),
    ["ABCD1234", "EFGH5678"],
  );
});

test("isValidCollectionKey accepts 8-char uppercase alphanumeric and rejects others", () => {
  assert.equal(isValidCollectionKey("ABCD1234"), true);
  assert.equal(isValidCollectionKey("12345678"), true);
  assert.equal(isValidCollectionKey("abcd1234"), false);
  assert.equal(isValidCollectionKey("ABCD123"), false);
  assert.equal(isValidCollectionKey("ABCD12345"), false);
  assert.equal(isValidCollectionKey("ABCD-234"), false);
});

test("fetchTopLevelItemKeysByCollections fetches itemKeys for a single collection", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response("ITEM0001\nITEM0002\n", {
      status: 200,
      headers: { "Content-Type": "text/plain", "Total-Results": "2" },
    });
  };

  const itemKeys = await fetchTopLevelItemKeysByCollections(
    ["ABCD1234"],
    userReadConfig,
    fetchMock,
  );

  assert.deepEqual(itemKeys, ["ITEM0001", "ITEM0002"]);
  assert.equal(requests.length, 1);

  const url = new URL(requests[0]!.url);
  assert.equal(url.origin, "https://api.zotero.org");
  assert.equal(url.pathname, "/users/123456/collections/ABCD1234/items/top");
  assert.equal(url.searchParams.get("format"), "keys");

  const headers = new Headers(requests[0]!.init?.headers);
  assert.equal(headers.get("Accept"), "text/plain");
  assert.equal(headers.get("Zotero-API-Version"), "3");
  assert.equal(headers.get("Zotero-API-Key"), "secret");
});

test("fetchTopLevelItemKeysByCollections uses group library URLs", async () => {
  const fetchMock: typeof fetch = async (input) => {
    assert.equal(
      String(input),
      "https://api.zotero.org/groups/7890/collections/ABCD1234/items/top?format=keys",
    );
    return new Response("", { status: 200 });
  };

  const itemKeys = await fetchTopLevelItemKeysByCollections(
    ["ABCD1234"],
    groupReadConfig,
    fetchMock,
  );

  assert.deepEqual(itemKeys, []);
});

test("fetchTopLevelItemKeysByCollections unions itemKeys across multiple collections and dedupes", async () => {
  const responses = new Map<string, string>([
    ["ABCD1234", "ITEM0001\nITEM0002\n"],
    ["EFGH5678", "ITEM0002\nITEM0003\n"],
  ]);
  const requests: string[] = [];
  const fetchMock: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const match = url.pathname.match(/\/collections\/([^/]+)\/items\/top$/u);
    assert.ok(match, `unexpected URL: ${url.pathname}`);
    const key = match[1]!;
    requests.push(key);
    const body = responses.get(key) ?? "";
    const lines = body.split(/\s+/u).filter((line) => line.length > 0);
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/plain", "Total-Results": String(lines.length) },
    });
  };

  const itemKeys = await fetchTopLevelItemKeysByCollections(
    ["ABCD1234", "EFGH5678", "ABCD1234"],
    userReadConfig,
    fetchMock,
  );

  assert.deepEqual(itemKeys, ["ITEM0001", "ITEM0002", "ITEM0003"]);
  assert.deepEqual(requests, ["ABCD1234", "EFGH5678"]);
});

test("fetchTopLevelItemKeysByCollections throws when Total-Results exceeds parsed count", async () => {
  const fetchMock: typeof fetch = async () =>
    new Response("ITEM0001\nITEM0002\n", {
      status: 200,
      headers: { "Content-Type": "text/plain", "Total-Results": "5" },
    });

  await assert.rejects(
    () => fetchTopLevelItemKeysByCollections(["ABCD1234"], userReadConfig, fetchMock),
    /Zotero returned 2 of 5 matching item keys/u,
  );
});

test("fetchTopLevelItemKeysByCollections surfaces 404 with a clear unknown-collection message", async () => {
  const fetchMock: typeof fetch = async () =>
    new Response("Not Found", { status: 404, statusText: "Not Found" });

  await assert.rejects(
    () => fetchTopLevelItemKeysByCollections(["ZZZZ9999"], userReadConfig, fetchMock),
    /Zotero collection ZZZZ9999 not found \(404\)/u,
  );
});
