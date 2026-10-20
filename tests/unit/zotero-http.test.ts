import test from "node:test";
import assert from "node:assert/strict";

import { resolveItemKeyFilter, type ZoteroCredentials } from "../../src/zotero-http.js";

const readConfig: ZoteroCredentials = {
  apiKey: "secret",
  libraryId: "123456",
  libraryType: "user",
};

/** format=keys responder: tag queries return one key set, each collection
 *  query returns its own. */
function keysFetchMock(byUrl: (url: string) => string[]): typeof fetch {
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    const keys = byUrl(url);
    return new Response(keys.join("\n"), {
      status: 200,
      headers: { "Total-Results": String(keys.length) },
    });
  };
}

test("resolveItemKeyFilter returns undefined when neither filter is given", async () => {
  const result = await resolveItemKeyFilter(undefined, undefined, readConfig, keysFetchMock(() => []));
  assert.equal(result, undefined);
});

test("resolveItemKeyFilter passes through a tag-only filter", async () => {
  const result = await resolveItemKeyFilter(["史学史"], undefined, readConfig, keysFetchMock((url) => {
    assert.match(url, /\/items\/top\?/u);
    return ["AAAA1111", "BBBB2222"];
  }));
  assert.deepEqual(result, { itemKeys: ["AAAA1111", "BBBB2222"], warnings: [] });
});

test("resolveItemKeyFilter intersects tag and collection matches, keeping tag order", async () => {
  const result = await resolveItemKeyFilter(
    ["史学史"],
    ["COLL0001"],
    readConfig,
    keysFetchMock((url) =>
      url.includes("/collections/")
        ? ["CCCC3333", "BBBB2222", "DDDD4444"]
        : ["AAAA1111", "BBBB2222", "CCCC3333"],
    ),
  );
  assert.deepEqual(result, { itemKeys: ["BBBB2222", "CCCC3333"], warnings: [] });
});

test("resolveItemKeyFilter yields an empty list when the intersection is empty", async () => {
  const result = await resolveItemKeyFilter(
    ["史学史"],
    ["COLL0001"],
    readConfig,
    keysFetchMock((url) => (url.includes("/collections/") ? ["ZZZZ9999"] : ["AAAA1111"])),
  );
  assert.deepEqual(result?.itemKeys, []);
  assert.deepEqual(result?.warnings, ["The tag and collection filters each match items, but no top-level item matches both."]);
});

test("resolveItemKeyFilter warns when a tag or collection matches no top-level item", async () => {
  const empty = keysFetchMock(() => []);
  const oneTag = await resolveItemKeyFilter(["nonexistent-tag"], undefined, readConfig, empty);
  assert.deepEqual(oneTag?.itemKeys, []);
  assert.equal(oneTag?.warnings.length, 1);
  assert.match(oneTag!.warnings[0]!, /^No top-level item carries the tag "nonexistent-tag"\. Check the spelling/);

  const twoTags = await resolveItemKeyFilter(["a", "b"], undefined, readConfig, empty);
  assert.match(twoTags!.warnings[0]!, /all of the tags "a", "b"; repeated --tag flags must all match/);

  const both = await resolveItemKeyFilter(["a"], ["COLL0001"], readConfig, empty);
  assert.equal(both?.warnings.length, 2);
  assert.match(both!.warnings[1]!, /^Collection "COLL0001" has no top-level items/);
});
