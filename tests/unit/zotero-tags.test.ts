import test from "node:test";
import assert from "node:assert/strict";

import { fetchTopLevelItemKeysByTags, normalizeTagFilters } from "../../src/zotero-tags.js";
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

test("normalizeTagFilters trims, drops blanks, and deduplicates tags", () => {
  assert.deepEqual(
    normalizeTagFilters([" PhD Thesis ", "", "PhD Thesis", "Core"]),
    ["PhD Thesis", "Core"],
  );
});

test("fetchTopLevelItemKeysByTags requests top-level item keys for repeated tags", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response("ITEM0001\nITEM0002\n", {
      status: 200,
      headers: { "Content-Type": "text/plain", "Total-Results": "2" },
    });
  };

  const itemKeys = await fetchTopLevelItemKeysByTags(
    ["PhD Thesis", " Core ", "PhD Thesis"],
    userReadConfig,
    fetchMock,
  );

  assert.deepEqual(itemKeys, ["ITEM0001", "ITEM0002"]);
  assert.equal(requests.length, 1);

  const url = new URL(requests[0]!.url);
  assert.equal(url.origin, "https://api.zotero.org");
  assert.equal(url.pathname, "/users/123456/items/top");
  assert.equal(url.searchParams.get("format"), "keys");
  assert.deepEqual(url.searchParams.getAll("tag"), ["PhD Thesis", "Core"]);

  const headers = new Headers(requests[0]!.init?.headers);
  assert.equal(headers.get("Accept"), "text/plain");
  assert.equal(headers.get("Zotero-API-Version"), "3");
  assert.equal(headers.get("Zotero-API-Key"), "secret");
});

test("fetchTopLevelItemKeysByTags uses group library URLs", async () => {
  const fetchMock: typeof fetch = async (input) => {
    assert.equal(
      String(input),
      "https://api.zotero.org/groups/7890/items/top?format=keys&tag=PhD+Thesis",
    );
    return new Response("", { status: 200 });
  };

  const itemKeys = await fetchTopLevelItemKeysByTags(["PhD Thesis"], groupReadConfig, fetchMock);

  assert.deepEqual(itemKeys, []);
});

test("fetchTopLevelItemKeysByTags throws if Total-Results exceeds the parsed count", async () => {
  const fetchMock: typeof fetch = async () =>
    new Response("ITEM0001\nITEM0002\n", {
      status: 200,
      headers: { "Content-Type": "text/plain", "Total-Results": "5" },
    });

  await assert.rejects(
    () => fetchTopLevelItemKeysByTags(["PhD Thesis"], userReadConfig, fetchMock),
    /Zotero returned 2 of 5 matching item keys/u,
  );
});
