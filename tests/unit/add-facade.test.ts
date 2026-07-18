import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAdd, runAddJson, type AddResult } from "../../src/add.js";
import { JsonInputError } from "../../src/json-input.js";

const WRITE_OVERRIDES = {
  zoteroLibraryId: "123456",
  zoteroLibraryType: "user" as const,
  zoteroApiKey: "secret",
  // Pin the doi.org / manual paths: a translationServerUrl in the
  // developer's real ~/.zotagent/config.json must not reroute these tests.
  translationServerUrl: "",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function journalArticleTemplate(): Record<string, unknown> {
  return {
    itemType: "journalArticle",
    title: "",
    creators: [],
    abstractNote: "",
    publicationTitle: "",
    date: "",
    url: "",
    accessDate: "",
    shortTitle: "",
    tags: [],
    collections: [],
    relations: {},
  };
}

/** Minimal Zotero write stub: serves /items/new templates and answers create
 *  POSTs with sequential item keys. */
function stubZoteroWrites(): { fetchMock: typeof fetch; created: number } {
  const state = { fetchMock: undefined as unknown as typeof fetch, created: 0 };
  const keys = ["KEY00001", "KEY00002", "KEY00003"];
  state.fetchMock = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://api.zotero.org/items/new")) {
      return jsonResponse(journalArticleTemplate());
    }
    if (/api\.zotero\.org\/users\/123456\/items$/u.test(url)) {
      const key = keys[state.created] ?? "KEY-OVERFLOW";
      state.created += 1;
      return jsonResponse({ success: { "0": key } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return state;
}

test("runAddJson keeps results aligned 1:1 with the input array across parse failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zotagent-add-facade-"));
  try {
    const jsonPath = join(dir, "items.json");
    writeFileSync(
      jsonPath,
      JSON.stringify([
        { title: "First Good", itemType: "journalArticle" },
        { note: "no title here" },
        { title: "Second Good", itemType: "journalArticle" },
      ]),
      "utf-8",
    );

    const stub = stubZoteroWrites();
    const results = await runAddJson(jsonPath, WRITE_OVERRIDES, undefined, stub.fetchMock);

    assert.equal(results.length, 3);
    const first = results[0] as AddResult;
    assert.equal(first.itemKey, "KEY00001");
    assert.equal(first.title, "First Good");
    assert.equal(first.source, "json");

    const failed = results[1];
    assert.ok("ok" in failed && failed.ok === false);
    assert.equal(failed.error.code, "INVALID_INPUT");
    assert.match(failed.error.message, /non-empty 'title'/u);

    // The cursor must skip the failed slot: the second created key lands on
    // the third input, not the second.
    const third = results[2] as AddResult;
    assert.equal(third.itemKey, "KEY00002");
    assert.equal(third.title, "Second Good");
    assert.equal(stub.created, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAddJson propagates bundle-level JsonInputError to the caller", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zotagent-add-facade-"));
  try {
    const jsonPath = join(dir, "empty.json");
    writeFileSync(jsonPath, "[]", "utf-8");
    await assert.rejects(
      () => runAddJson(jsonPath, WRITE_OVERRIDES, undefined, stubZoteroWrites().fetchMock),
      (err: unknown) => err instanceof JsonInputError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAdd dispatches doi-or-manual to a manual create", async () => {
  const stub = stubZoteroWrites();
  const outcome = await runAdd(
    { kind: "doi-or-manual", input: { title: "Dispatch Test", publication: "Journal of Testing" } },
    WRITE_OVERRIDES,
    stub.fetchMock,
  );

  assert.ok(!("multiple" in outcome));
  assert.equal(outcome.source, "manual");
  assert.equal(outcome.itemKey, "KEY00001");
  assert.equal(outcome.title, "Dispatch Test");
});

test("runAdd surfaces --from-url multiple candidates as a choices outcome", async () => {
  const fetchMock: typeof fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "http://127.0.0.1:1969/web") {
      return jsonResponse(
        {
          url: "https://example.com/list",
          session: "abc",
          items: { k1: "Choice One", k2: "Choice Two" },
        },
        300,
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const outcome = await runAdd(
    { kind: "url", url: "https://example.com/list" },
    { ...WRITE_OVERRIDES, translationServerUrl: "http://127.0.0.1:1969" },
    fetchMock,
  );

  assert.ok("multiple" in outcome);
  assert.equal(outcome.url, "https://example.com/list");
  assert.deepEqual(outcome.choices, [
    { key: "k1", title: "Choice One" },
    { key: "k2", title: "Choice Two" },
  ]);
});
