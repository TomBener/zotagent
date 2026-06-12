import test from "node:test";
import assert from "node:assert/strict";

import { addFromIdentifier, addFromUrl, addToZotero } from "../../src/add.js";
import { TranslationServerError } from "../../src/translation-server.js";

const SERVER = "http://127.0.0.1:1969";
const ACCESS_DATE_LOCAL_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u;

const WRITE_OVERRIDES = {
  zoteroLibraryId: "123456",
  zoteroLibraryType: "user",
  zoteroApiKey: "secret",
  translationServerUrl: SERVER,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function webpageTemplate(): Record<string, unknown> {
  return {
    itemType: "webpage",
    title: "",
    creators: [],
    abstractNote: "",
    websiteTitle: "",
    websiteType: "",
    date: "",
    shortTitle: "",
    url: "",
    accessDate: "",
    language: "",
    rights: "",
    extra: "",
    tags: [],
    collections: [],
    relations: {},
  };
}

function journalArticleTemplate(): Record<string, unknown> {
  return {
    itemType: "journalArticle",
    title: "",
    creators: [],
    abstractNote: "",
    publicationTitle: "",
    volume: "",
    issue: "",
    pages: "",
    date: "",
    series: "",
    seriesTitle: "",
    journalAbbreviation: "",
    language: "",
    DOI: "",
    ISSN: "",
    shortTitle: "",
    url: "",
    accessDate: "",
    libraryCatalog: "",
    rights: "",
    extra: "",
    tags: [],
    collections: [],
    relations: {},
  };
}

function bookTemplate(): Record<string, unknown> {
  return {
    itemType: "book",
    title: "",
    creators: [],
    abstractNote: "",
    series: "",
    seriesNumber: "",
    volume: "",
    edition: "",
    place: "",
    publisher: "",
    date: "",
    numPages: "",
    language: "",
    ISBN: "",
    shortTitle: "",
    url: "",
    accessDate: "",
    libraryCatalog: "",
    rights: "",
    extra: "",
    tags: [],
    collections: [],
    relations: {},
  };
}

function noteTemplate(): Record<string, unknown> {
  return {
    itemType: "note",
    note: "",
    tags: [],
    collections: [],
    relations: {},
  };
}

interface RecordedRequest {
  url: string;
  init?: RequestInit;
}

interface TranslationStubOptions {
  /** Handler for translation-server requests, keyed by endpoint path. */
  web?: (init?: RequestInit) => Response | Promise<Response>;
  search?: (init?: RequestInit) => Response | Promise<Response>;
  itemKeys?: string[];
}

function stubFetch(options: TranslationStubOptions): {
  fetchMock: typeof fetch;
  requests: RecordedRequest[];
  zoteroCreates: () => Array<Record<string, unknown>>;
} {
  const templates: Record<string, Record<string, unknown>> = {
    webpage: webpageTemplate(),
    journalArticle: journalArticleTemplate(),
    book: bookTemplate(),
    note: noteTemplate(),
  };
  const itemKeys = options.itemKeys ?? ["KEY00001", "KEY00002", "KEY00003"];
  let createCursor = 0;
  const requests: RecordedRequest[] = [];

  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });

    if (url === `${SERVER}/web` && options.web) return options.web(init);
    if (url === `${SERVER}/search` && options.search) return options.search(init);

    const newMatch = /^https:\/\/api\.zotero\.org\/items\/new\?itemType=([^&]+)/u.exec(url);
    if (newMatch) {
      const itemType = decodeURIComponent(newMatch[1]);
      const template = templates[itemType];
      if (!template) return new Response(`Unknown itemType: ${itemType}`, { status: 400 });
      return jsonResponse(template);
    }

    if (/^https:\/\/api\.zotero\.org\/users\/123456\/items$/u.test(url)) {
      const key = itemKeys[createCursor++] ?? `KEY${String(createCursor).padStart(5, "0")}`;
      return jsonResponse({ success: { "0": key } });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const zoteroCreates = (): Array<Record<string, unknown>> =>
    requests
      .filter((request) => /api\.zotero\.org\/users\/123456\/items$/u.test(request.url))
      .map((request) => (JSON.parse(String(request.init?.body)) as Array<Record<string, unknown>>)[0]);

  return { fetchMock, requests, zoteroCreates };
}

test("addFromUrl creates an item from translator output with tags and flattened child notes", async () => {
  // Shape matches what translation-server actually emits (itemToAPIJSON):
  // children arrive as sibling entries with parentItem = the parent's temp
  // key; attachments are dropped by the server entirely.
  const translated = [
    {
      key: "SRCKEY01",
      version: 0,
      itemType: "webpage",
      title: "Example Page: A Story",
      creators: [{ firstName: "Jane", lastName: "Doe", creatorType: "author" }],
      abstractNote: "An abstract from the page metadata.",
      websiteTitle: "Example Site",
      date: "2026-01-02",
      language: "en",
      url: "https://example.com/article",
      accessDate: "2026-06-12T08:00:00Z",
      bogusField: "must be dropped by template gating",
      tags: [{ tag: "automatic keyword", type: 1 }, "plain keyword"],
    },
    { itemType: "note", parentItem: "SRCKEY01", note: "<p>translator note</p>" },
    { itemType: "note", parentItem: "OTHERKEY", note: "<p>belongs to a dropped item</p>" },
  ];
  const { fetchMock, requests, zoteroCreates } = stubFetch({
    web: () => jsonResponse(translated),
    itemKeys: ["PARENT01", "NOTE0001"],
  });

  const result = await addFromUrl("https://example.com/article", {}, {}, WRITE_OVERRIDES, fetchMock);

  assert.ok(!("multiple" in result), "expected a created item, not choices");
  assert.equal(result.itemKey, "PARENT01");
  assert.equal(result.itemType, "webpage");
  assert.equal(result.source, "url");
  assert.equal(result.title, "Example Page: A Story");
  assert.deepEqual(result.noteItemKeys, ["NOTE0001"]);

  const webRequest = requests.find((request) => request.url === `${SERVER}/web`);
  assert.ok(webRequest);
  assert.equal(String(webRequest.init?.body), "https://example.com/article");

  const creates = zoteroCreates();
  assert.equal(creates.length, 2, "exactly one parent and one matching child note");
  const [parent, note] = creates;
  assert.equal(parent.title, "Example Page: A Story");
  assert.equal(parent.shortTitle, "Example Page");
  assert.equal(parent.websiteTitle, "Example Site");
  assert.equal(parent.language, "en");
  assert.equal(parent.abstractNote, "An abstract from the page metadata.");
  assert.equal("bogusField" in parent, false, "unknown fields must be template-gated away");
  assert.equal("key" in parent && parent.key === "SRCKEY01", false, "source key must not leak");
  // The server's UTC accessDate is re-stamped in zotagent's local form.
  assert.match(String(parent.accessDate), ACCESS_DATE_LOCAL_RE);
  assert.deepEqual(parent.creators, [
    { creatorType: "author", firstName: "Jane", lastName: "Doe" },
  ]);
  assert.deepEqual(parent.tags, [
    { tag: "automatic keyword", type: 1 },
    { tag: "plain keyword" },
    { tag: "Added by AI Agent" },
  ]);

  assert.equal(note.itemType, "note");
  assert.equal(note.note, "<p>translator note</p>");
  assert.equal(note.parentItem, "PARENT01");
});

test("addFromUrl surfaces multiple candidates as choices without writing to Zotero", async () => {
  const { fetchMock, requests } = stubFetch({
    web: () =>
      jsonResponse(
        {
          url: "https://example.com/search?q=x",
          session: "sess-1",
          items: { "0": "First Candidate", "1": { title: "Second Candidate" } },
        },
        300,
      ),
  });

  const result = await addFromUrl("https://example.com/search?q=x", {}, {}, WRITE_OVERRIDES, fetchMock);

  assert.ok("multiple" in result, "expected choices");
  assert.equal(result.multiple, true);
  assert.equal(result.url, "https://example.com/search?q=x");
  assert.deepEqual(result.choices, [
    { key: "0", title: "First Candidate" },
    { key: "1", title: "Second Candidate" },
  ]);
  assert.equal(
    requests.filter((request) => request.url.startsWith("https://api.zotero.org/")).length,
    0,
    "no Zotero call may happen for a multiple-candidate page",
  );
});

test("addFromUrl with select imports the chosen candidate", async () => {
  const picked = {
    itemType: "journalArticle",
    title: "Picked Article",
    creators: [{ firstName: "Ada", lastName: "Lovelace", creatorType: "author" }],
    DOI: "10.1000/picked",
    accessDate: "CURRENT_TIMESTAMP",
  };
  const { fetchMock, zoteroCreates } = stubFetch({
    web: (init) => {
      const contentType = (init?.headers as Record<string, string>)["Content-Type"];
      if (contentType === "text/plain") {
        return jsonResponse(
          { url: "https://example.com/s", session: "sess-2", items: { a: "A", b: "Picked Article" } },
          300,
        );
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.session, "sess-2");
      assert.deepEqual(body.items, { b: "Picked Article" });
      return jsonResponse([picked]);
    },
    itemKeys: ["PICK0001"],
  });

  const result = await addFromUrl(
    "https://example.com/s",
    {},
    { select: "b" },
    WRITE_OVERRIDES,
    fetchMock,
  );

  assert.ok(!("multiple" in result));
  assert.equal(result.itemKey, "PICK0001");
  assert.equal(result.source, "url");
  assert.equal(result.doi, "10.1000/picked");
  const [parent] = zoteroCreates();
  assert.equal(parent.title, "Picked Article");
});

test("addFromUrl applies manual overrides and the configured default collection", async () => {
  const translated = {
    itemType: "webpage",
    title: "Original Title",
    url: "https://example.com/page",
    accessDate: "CURRENT_TIMESTAMP",
  };
  const { fetchMock, zoteroCreates } = stubFetch({
    web: () => jsonResponse([translated]),
    itemKeys: ["OVER0001"],
  });

  const result = await addFromUrl(
    "https://example.com/page",
    { title: "Override Title: Subtitle", authors: ["Doe, Jane"] },
    {},
    { ...WRITE_OVERRIDES, zoteroCollectionKey: "COLKEY01" },
    fetchMock,
  );

  assert.ok(!("multiple" in result));
  assert.equal(result.title, "Override Title: Subtitle");
  const [parent] = zoteroCreates();
  assert.equal(parent.title, "Override Title: Subtitle");
  assert.equal(parent.shortTitle, "Override Title", "shortTitle must re-derive from the override");
  assert.deepEqual(parent.creators, [{ creatorType: "author", firstName: "Jane", lastName: "Doe" }]);
  assert.deepEqual(parent.collections, ["COLKEY01"]);
});

test("addFromUrl without translationServerUrl fails fast with setup instructions", async () => {
  const { fetchMock, requests } = stubFetch({});

  await assert.rejects(
    addFromUrl(
      "https://example.com",
      {},
      {},
      {
        zoteroLibraryId: "123456",
        zoteroLibraryType: "user",
        zoteroApiKey: "secret",
        // Explicit "" disables the server even when the developer's real
        // config / environment has one configured.
        translationServerUrl: "",
      },
      fetchMock,
    ),
    (error: unknown) => {
      assert.ok(error instanceof TranslationServerError);
      assert.equal(error.code, "TRANSLATION_SERVER_NOT_CONFIGURED");
      assert.match(error.message, /translationServerUrl/u);
      return true;
    },
  );
  assert.equal(requests.length, 0, "must fail before any network call");
});

test("addFromUrl validates --attach-file before any network call", async () => {
  const { fetchMock, requests } = stubFetch({
    web: () => jsonResponse([{ itemType: "webpage", title: "X" }]),
  });

  await assert.rejects(
    addFromUrl(
      "https://example.com",
      { attachFile: "/no/such/file.pdf" },
      {},
      WRITE_OVERRIDES,
      fetchMock,
    ),
    /attach-file not found/u,
  );
  assert.equal(requests.length, 0, "bad attach path must abort before translation/Zotero calls");
});

test("addFromIdentifier imports a book by ISBN and preserves editor creators", async () => {
  const translated = {
    itemType: "book",
    title: "Edited Volume: Essays",
    creators: [
      { firstName: "Jane", lastName: "Doe", creatorType: "editor" },
      { firstName: "John", lastName: "Smith", creatorType: "author" },
    ],
    place: "Cambridge",
    publisher: "Test Press",
    edition: "2nd",
    date: "2020",
    ISBN: "9780000000000",
    language: "en",
    libraryCatalog: "Library of Congress",
  };
  const { fetchMock, requests, zoteroCreates } = stubFetch({
    search: () => jsonResponse([translated]),
    itemKeys: ["BOOK0001"],
  });

  const result = await addFromIdentifier("9780000000000", {}, WRITE_OVERRIDES, fetchMock);

  assert.equal(result.itemKey, "BOOK0001");
  assert.equal(result.source, "identifier");
  assert.equal(result.identifier, "9780000000000");
  assert.equal(result.itemType, "book");

  const searchRequest = requests.find((request) => request.url === `${SERVER}/search`);
  assert.ok(searchRequest);
  assert.equal(String(searchRequest.init?.body), "9780000000000");

  const [parent] = zoteroCreates();
  assert.equal(parent.place, "Cambridge");
  assert.equal(parent.edition, "2nd");
  assert.deepEqual(parent.creators, [
    { creatorType: "editor", firstName: "Jane", lastName: "Doe" },
    { creatorType: "author", firstName: "John", lastName: "Smith" },
  ]);
});

test("addToZotero --doi resolves through translation-server when configured", async () => {
  const translated = {
    itemType: "journalArticle",
    title: "Server Resolved Article",
    creators: [
      { firstName: "Ada", lastName: "Lovelace", creatorType: "author" },
      { firstName: "Grace", lastName: "Hopper", creatorType: "editor" },
    ],
    publicationTitle: "Journal of Tests",
    journalAbbreviation: "J. Tests",
    abstractNote: "Deposited abstract.",
    language: "en",
    volume: "5",
    issue: "2",
    pages: "10-20",
    date: "2025-06-01",
    ISSN: "1234-5678",
    url: "https://doi.org/10.1000/translated",
    accessDate: "CURRENT_TIMESTAMP",
  };
  const { fetchMock, requests, zoteroCreates } = stubFetch({
    search: () => jsonResponse([translated]),
    itemKeys: ["DOITS001"],
  });

  const result = await addToZotero({ doi: "10.1000/translated" }, WRITE_OVERRIDES, fetchMock);

  assert.equal(result.itemKey, "DOITS001");
  assert.equal(result.source, "doi");
  assert.equal(result.doi, "10.1000/translated");

  assert.equal(
    requests.some((request) => request.url.startsWith("https://doi.org/")),
    false,
    "doi.org CSL fallback must not be queried when the server is configured",
  );
  const searchRequest = requests.find((request) => request.url === `${SERVER}/search`);
  assert.ok(searchRequest);
  assert.equal(String(searchRequest.init?.body), "10.1000/translated");

  const [parent] = zoteroCreates();
  assert.equal(parent.journalAbbreviation, "J. Tests");
  assert.equal(parent.language, "en");
  assert.equal(parent.DOI, "10.1000/translated", "DOI must be backfilled when the item lacks it");
  assert.deepEqual(parent.creators, [
    { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
    { creatorType: "editor", firstName: "Grace", lastName: "Hopper" },
  ]);
});

test("addToZotero --doi reports the DOI actually written when the translator normalizes it", async () => {
  // DOIs are case-insensitive; registrants return the canonical form. The
  // written item carries the translator's DOI, and the result must match it.
  const translated = {
    itemType: "journalArticle",
    title: "Case Normalized Article",
    DOI: "10.1000/abc",
  };
  const { fetchMock, zoteroCreates } = stubFetch({
    search: () => jsonResponse([translated]),
    itemKeys: ["CASE0001"],
  });

  const result = await addToZotero({ doi: "10.1000/ABC" }, WRITE_OVERRIDES, fetchMock);

  const [parent] = zoteroCreates();
  assert.equal(parent.DOI, "10.1000/abc");
  assert.equal(result.doi, "10.1000/abc", "result.doi must reflect the written item, not the raw input");
});

test("addToZotero --doi keeps the requested DOI when the item type has no DOI field", async () => {
  const translated = {
    itemType: "book",
    title: "A Book Resolved by DOI",
    publisher: "Test Press",
  };
  const { fetchMock, zoteroCreates } = stubFetch({
    search: () => jsonResponse([translated]),
    itemKeys: ["BOOKDOI1"],
  });

  const result = await addToZotero({ doi: "10.1000/book" }, WRITE_OVERRIDES, fetchMock);

  const [parent] = zoteroCreates();
  assert.equal("DOI" in parent, false, "book template has no DOI field to write");
  assert.equal(result.doi, "10.1000/book", "the requested DOI is still reported for traceability");
});

test("addToZotero --doi falls back to manual fields when the server lookup fails", async () => {
  const { fetchMock, zoteroCreates } = stubFetch({
    search: () => new Response("An error occurred during translation", { status: 500 }),
    itemKeys: ["FALL0001"],
  });

  const result = await addToZotero(
    { doi: "10.1000/broken", title: "Fallback Title", publication: "Journal of Fallbacks" },
    WRITE_OVERRIDES,
    fetchMock,
  );

  assert.equal(result.itemKey, "FALL0001");
  assert.equal(result.source, "manual-fallback");
  assert.equal(result.doi, "10.1000/broken");
  assert.match(result.warnings?.[0] || "", /DOI import failed/u);

  const [parent] = zoteroCreates();
  assert.equal(parent.title, "Fallback Title");
  assert.equal(parent.DOI, "10.1000/broken");
});

test("addToZotero --doi without --title propagates the translation-server error", async () => {
  const fetchMock: typeof fetch = async (input) => {
    if (String(input) === `${SERVER}/search`) {
      throw new TypeError("fetch failed");
    }
    throw new Error(`Unexpected URL: ${String(input)}`);
  };

  await assert.rejects(
    addToZotero({ doi: "10.1000/unreachable" }, WRITE_OVERRIDES, fetchMock),
    (error: unknown) => {
      assert.ok(error instanceof TranslationServerError);
      assert.equal(error.code, "TRANSLATION_SERVER_UNREACHABLE");
      return true;
    },
  );
});
