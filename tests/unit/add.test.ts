import test from "node:test";
import assert from "node:assert/strict";

import { addJsonItemsToZotero, addS2PaperToZotero, addToZotero } from "../../src/add.js";
import { mapLenientItem } from "../../src/json-input.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

test("addToZotero creates a manual item from basic fields", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });

    if (url === "https://api.zotero.org/items/new?itemType=journalArticle") {
      return jsonResponse({
        itemType: "journalArticle",
        title: "",
        creators: [],
        date: "",
        publicationTitle: "",
        url: "",
        accessDate: "",
        tags: [],
        collections: [],
        relations: {},
      });
    }

    if (url === "https://api.zotero.org/users/123456/items") {
      return jsonResponse({
        success: {
          "0": "ABCD2345",
        },
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await addToZotero(
    {
      title: "Manual Entry",
      authors: ["Doe, Jane", "Research Center"],
      year: "2026",
      publication: "Journal of Testing",
      url: "https://example.com/article",
      urlDate: "2026-04-02",
    },
    {
      zoteroLibraryId: "123456",
      zoteroLibraryType: "user",
      zoteroApiKey: "secret",
    },
    fetchMock,
  );

  assert.deepEqual(result, {
    itemKey: "ABCD2345",
    title: "Manual Entry",
    itemType: "journalArticle",
    created: true,
    source: "manual",
    warnings: [],
  });

  const createRequest = requests.at(-1);
  assert.ok(createRequest);
  const body = JSON.parse(String(createRequest?.init?.body)) as Array<Record<string, unknown>>;
  assert.equal(body[0]?.title, "Manual Entry");
  assert.equal(body[0]?.date, "2026");
  assert.equal(body[0]?.publicationTitle, "Journal of Testing");
  assert.equal(body[0]?.url, "https://example.com/article");
  assert.equal(body[0]?.accessDate, "2026-04-02");
  assert.deepEqual(body[0]?.tags, [{ tag: "Added by AI Agent" }]);
  assert.deepEqual(body[0]?.creators, [
    {
      creatorType: "author",
      firstName: "Jane",
      lastName: "Doe",
    },
    {
      creatorType: "author",
      firstName: "Research",
      lastName: "Center",
    },
  ]);
});

test("addToZotero applies the configured default collection key", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });

    if (url === "https://api.zotero.org/items/new?itemType=journalArticle") {
      return jsonResponse({
        itemType: "journalArticle",
        title: "",
        creators: [],
        date: "",
        publicationTitle: "",
        url: "",
        accessDate: "",
        tags: [],
        collections: [],
        relations: {},
      });
    }

    if (url === "https://api.zotero.org/groups/7890/items") {
      return jsonResponse({
        success: {
          "0": "COLL1234",
        },
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  await addToZotero(
    {
      title: "Grouped Entry",
    },
    {
      zoteroLibraryId: "7890",
      zoteroLibraryType: "group",
      zoteroCollectionKey: "COLKEY123",
      zoteroApiKey: "secret",
    },
    fetchMock,
  );

  const createRequest = requests.at(-1);
  assert.ok(createRequest);
  const body = JSON.parse(String(createRequest?.init?.body)) as Array<Record<string, unknown>>;
  assert.deepEqual(body[0]?.collections, ["COLKEY123"]);
});

test("addToZotero lets command input override the configured collection key", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });

    if (url === "https://api.zotero.org/items/new?itemType=journalArticle") {
      return jsonResponse({
        itemType: "journalArticle",
        title: "",
        creators: [],
        date: "",
        publicationTitle: "",
        url: "",
        accessDate: "",
        tags: [],
        collections: [],
        relations: {},
      });
    }

    if (url === "https://api.zotero.org/users/123456/items") {
      return jsonResponse({
        success: {
          "0": "OVERRIDE1",
        },
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  await addToZotero(
    {
      title: "Manual Entry",
      collectionKey: "CLIKEY999",
    },
    {
      zoteroLibraryId: "123456",
      zoteroLibraryType: "user",
      zoteroCollectionKey: "CONFIGKEY1",
      zoteroApiKey: "secret",
    },
    fetchMock,
  );

  const createRequest = requests.at(-1);
  assert.ok(createRequest);
  const body = JSON.parse(String(createRequest?.init?.body)) as Array<Record<string, unknown>>;
  assert.deepEqual(body[0]?.collections, ["CLIKEY999"]);
});

test("addToZotero falls back to manual fields when DOI lookup fails", async () => {
  const requests: string[] = [];
  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);

    if (url === "https://doi.org/10.1000/missing") {
      return new Response("not found", { status: 404 });
    }
    if (url === "https://api.zotero.org/items/new?itemType=webpage") {
      return jsonResponse({
        itemType: "webpage",
        title: "",
        creators: [],
        date: "",
        websiteTitle: "",
        url: "",
        accessDate: "",
        tags: [],
        collections: [],
        relations: {},
      });
    }
    if (url === "https://api.zotero.org/users/123456/items") {
      return jsonResponse({
        success: {
          "0": "WXYZ6789",
        },
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await addToZotero(
    {
      doi: "10.1000/missing",
      title: "Fallback Entry",
      authors: ["Center for History and New Media"],
      url: "https://example.com/fallback",
      urlDate: "2026-04-02",
    },
    {
      zoteroLibraryId: "123456",
      zoteroLibraryType: "user",
      zoteroApiKey: "secret",
    },
    fetchMock,
  );

  assert.equal(result.itemKey, "WXYZ6789");
  assert.equal(result.title, "Fallback Entry");
  assert.equal(result.itemType, "webpage");
  assert.equal(result.created, true);
  assert.equal(result.source, "manual-fallback");
  assert.equal(result.doi, "10.1000/missing");
  assert.match(result.warnings[0] || "", /DOI import failed/);
  assert.deepEqual(requests, [
    "https://doi.org/10.1000/missing",
    "https://api.zotero.org/items/new?itemType=webpage",
    "https://api.zotero.org/users/123456/items",
  ]);
});

test("addToZotero omits publisher for journal articles imported from DOI", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });

    if (url === "https://doi.org/10.1016/j.econmod.2026.107590") {
      return jsonResponse({
        type: "article-journal",
        title: "Imported by DOI",
        publisher: "Elsevier BV",
        "container-title": ["Journal of Testing"],
        issued: { "date-parts": [[2026, 3, 30]] },
        author: [{ family: "Smith", given: "Ada" }],
      });
    }
    if (url === "https://api.zotero.org/items/new?itemType=journalArticle") {
      return jsonResponse({
        itemType: "journalArticle",
        title: "",
        creators: [],
        date: "",
        publicationTitle: "",
        publisher: "",
        url: "",
        accessDate: "",
        DOI: "",
        tags: [],
        collections: [],
        relations: {},
      });
    }
    if (url === "https://api.zotero.org/users/123456/items") {
      return jsonResponse({
        success: {
          "0": "TIME1234",
        },
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await addToZotero(
    {
      doi: "10.1016/j.econmod.2026.107590",
    },
    {
      zoteroLibraryId: "123456",
      zoteroLibraryType: "user",
      zoteroApiKey: "secret",
    },
    fetchMock,
  );

  assert.equal(result.itemKey, "TIME1234");
  assert.equal(result.source, "doi");
  assert.deepEqual(result.warnings, []);

  const createRequest = requests.at(-1);
  assert.ok(createRequest);
  const body = JSON.parse(String(createRequest?.init?.body)) as Array<Record<string, unknown>>;
  assert.equal(body[0]?.publicationTitle, "Journal of Testing");
  assert.equal(body[0]?.publisher, "");
  assert.deepEqual(body[0]?.tags, [{ tag: "Added by AI Agent" }]);
});

test("addS2PaperToZotero imports via DOI and allows manual overrides", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });

    if (url === "https://api.semanticscholar.org/graph/v1/paper/paper-123?fields=title%2Cauthors%2Cyear%2CexternalIds%2CpublicationTypes%2Cjournal%2Curl%2CopenAccessPdf%2CpublicationDate%2Cvenue%2Cabstract") {
      return jsonResponse({
        paperId: "paper-123",
        title: "Semantic Scholar Title",
        authors: [{ name: "Ada Lovelace" }],
        year: 2024,
        externalIds: { DOI: "10.1000/s2-paper" },
        publicationTypes: ["JournalArticle"],
        journal: { name: "Journal of Graphs" },
        publicationDate: "2024-05-01",
        abstract: "Imported from S2",
      });
    }
    if (url === "https://doi.org/10.1000/s2-paper") {
      return jsonResponse({
        type: "article-journal",
        title: "DOI Title",
        "container-title": ["Journal of Graphs"],
        issued: { "date-parts": [[2024, 5, 1]] },
        author: [{ family: "Lovelace", given: "Ada" }],
      });
    }
    if (url === "https://api.zotero.org/items/new?itemType=journalArticle") {
      return jsonResponse({
        itemType: "journalArticle",
        title: "",
        creators: [],
        date: "",
        publicationTitle: "",
        abstractNote: "",
        url: "",
        accessDate: "",
        DOI: "",
        tags: [],
        collections: [],
        relations: {},
      });
    }
    if (url === "https://api.zotero.org/users/123456/items") {
      return jsonResponse({
        success: {
          "0": "S2DOI123",
        },
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await addS2PaperToZotero(
    "paper-123",
    {
      title: "Override Title",
    },
    {
      semanticScholarApiKey: "s2-secret",
      zoteroLibraryId: "123456",
      zoteroLibraryType: "user",
      zoteroApiKey: "secret",
    },
    fetchMock,
  );

  assert.equal(result.itemKey, "S2DOI123");
  assert.equal(result.source, "doi");
  assert.equal(result.doi, "10.1000/s2-paper");
  assert.equal(result.s2PaperId, "paper-123");

  const createRequest = requests.at(-1);
  assert.ok(createRequest);
  const body = JSON.parse(String(createRequest?.init?.body)) as Array<Record<string, unknown>>;
  assert.equal(body[0]?.title, "Override Title");
  assert.equal(body[0]?.publicationTitle, "Journal of Graphs");
  assert.equal(body[0]?.abstractNote, "Imported from S2");
});

test("addS2PaperToZotero creates a manual item when no DOI is available", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });

    if (url === "https://api.semanticscholar.org/graph/v1/paper/paper-456?fields=title%2Cauthors%2Cyear%2CexternalIds%2CpublicationTypes%2Cjournal%2Curl%2CopenAccessPdf%2CpublicationDate%2Cvenue%2Cabstract") {
      return jsonResponse({
        paperId: "paper-456",
        title: "Conference Paper",
        authors: [{ name: "Grace Hopper" }, { name: "Research Group" }],
        year: 2023,
        publicationTypes: ["Conference"],
        venue: "Proceedings of Testing",
        url: "https://www.semanticscholar.org/paper/paper-456",
        abstract: "No DOI available",
      });
    }
    if (url === "https://api.zotero.org/items/new?itemType=conferencePaper") {
      return jsonResponse({
        itemType: "conferencePaper",
        title: "",
        creators: [],
        date: "",
        proceedingsTitle: "",
        abstractNote: "",
        url: "",
        accessDate: "",
        tags: [],
        collections: [],
        relations: {},
      });
    }
    if (url === "https://api.zotero.org/users/123456/items") {
      return jsonResponse({
        success: {
          "0": "S2MANUAL1",
        },
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await addS2PaperToZotero(
    "paper-456",
    {},
    {
      semanticScholarApiKey: "s2-secret",
      zoteroLibraryId: "123456",
      zoteroLibraryType: "user",
      zoteroApiKey: "secret",
    },
    fetchMock,
  );

  assert.equal(result.itemKey, "S2MANUAL1");
  assert.equal(result.source, "manual");
  assert.equal(result.s2PaperId, "paper-456");

  const createRequest = requests.at(-1);
  assert.ok(createRequest);
  const body = JSON.parse(String(createRequest?.init?.body)) as Array<Record<string, unknown>>;
  assert.equal(body[0]?.title, "Conference Paper");
  assert.equal(body[0]?.proceedingsTitle, "Proceedings of Testing");
  assert.equal(body[0]?.abstractNote, "No DOI available");
  assert.equal(body[0]?.url, "https://www.semanticscholar.org/paper/paper-456");
});

test("addS2PaperToZotero carries collection overrides into the created item", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });

    if (url === "https://api.semanticscholar.org/graph/v1/paper/paper-789?fields=title%2Cauthors%2Cyear%2CexternalIds%2CpublicationTypes%2Cjournal%2Curl%2CopenAccessPdf%2CpublicationDate%2Cvenue%2Cabstract") {
      return jsonResponse({
        paperId: "paper-789",
        title: "Configured Collection Paper",
        authors: [{ name: "Jane Doe" }],
        year: 2025,
        publicationTypes: ["JournalArticle"],
        journal: { name: "Testing Journal" },
      });
    }
    if (url === "https://api.zotero.org/items/new?itemType=journalArticle") {
      return jsonResponse({
        itemType: "journalArticle",
        title: "",
        creators: [],
        date: "",
        publicationTitle: "",
        abstractNote: "",
        url: "",
        accessDate: "",
        tags: [],
        collections: [],
        relations: {},
      });
    }
    if (url === "https://api.zotero.org/users/123456/items") {
      return jsonResponse({
        success: {
          "0": "S2COLL01",
        },
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  await addS2PaperToZotero(
    "paper-789",
    {
      collectionKey: "PAPERCOL1",
    },
    {
      semanticScholarApiKey: "s2-secret",
      zoteroLibraryId: "123456",
      zoteroLibraryType: "user",
      zoteroCollectionKey: "CONFIGCOL1",
      zoteroApiKey: "secret",
    },
    fetchMock,
  );

  const createRequest = requests.at(-1);
  assert.ok(createRequest);
  const body = JSON.parse(String(createRequest?.init?.body)) as Array<Record<string, unknown>>;
  assert.deepEqual(body[0]?.collections, ["PAPERCOL1"]);
});

// --- Helpers and tests for add --json mode -----------------------------------

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
    seriesText: "",
    seriesTitle: "",
    journalAbbreviation: "",
    language: "",
    DOI: "",
    ISSN: "",
    shortTitle: "",
    url: "",
    accessDate: "",
    archive: "",
    archiveLocation: "",
    libraryCatalog: "",
    callNumber: "",
    rights: "",
    extra: "",
    tags: [],
    collections: [],
    relations: {},
  };
}

function thesisTemplate(): Record<string, unknown> {
  return {
    itemType: "thesis",
    title: "",
    creators: [],
    abstractNote: "",
    thesisType: "",
    university: "",
    place: "",
    date: "",
    numPages: "",
    language: "",
    shortTitle: "",
    url: "",
    accessDate: "",
    archive: "",
    archiveLocation: "",
    libraryCatalog: "",
    callNumber: "",
    rights: "",
    extra: "",
    tags: [],
    collections: [],
    relations: {},
  };
}

interface StubbedZoteroOptions {
  templates?: Record<string, Record<string, unknown>>;
  /** Map of itemType → HTTP status to return on /items/new. Used to simulate
   *  Zotero rejecting an unknown itemType. */
  templateStatus?: Record<string, number>;
  /** Override the itemKey returned by sequential create POSTs. */
  itemKeys?: string[];
}

interface StubbedZotero {
  fetchMock: typeof fetch;
  requests: Array<{ url: string; init?: RequestInit }>;
}

function stubZotero(options: StubbedZoteroOptions = {}): StubbedZotero {
  const templates = {
    journalArticle: journalArticleTemplate(),
    thesis: thesisTemplate(),
    ...options.templates,
  };
  const templateStatus = options.templateStatus ?? {};
  const itemKeys = options.itemKeys ?? ["KEY00001", "KEY00002", "KEY00003", "KEY00004", "KEY00005"];
  let createCursor = 0;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });

    const newMatch = /^https:\/\/api\.zotero\.org\/items\/new\?itemType=([^&]+)/u.exec(url);
    if (newMatch) {
      const itemType = decodeURIComponent(newMatch[1]);
      if (templateStatus[itemType] !== undefined) {
        return new Response(`Unknown itemType: ${itemType}`, {
          status: templateStatus[itemType],
        });
      }
      const template = templates[itemType];
      if (!template) {
        return new Response(`Unknown itemType: ${itemType}`, { status: 400 });
      }
      return jsonResponse(template);
    }

    if (/\/items$/u.test(url)) {
      const key = itemKeys[createCursor++] ?? `KEY${String(createCursor).padStart(5, "0")}`;
      return jsonResponse({ success: { "0": key } });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };
  return { fetchMock, requests };
}

test("addJsonItemsToZotero creates a single item from a Zotero-shaped object", async () => {
  const { fetchMock, requests } = stubZotero({ itemKeys: ["FIX00001"] });
  const input = mapLenientItem({
    itemType: "journalArticle",
    title: "安汉与抗战时期西北垦殖运动",
    authors: ["储竞争"],
    publicationTitle: "农业考古",
    year: "2023",
    issue: "01",
    DOI: "10.13568/j.cnki.test.2023.01.001",
    abstractNote: "安汉，陕西南郑人，民国著名农学家、垦殖专家。抗战时期投身西北开发，其指导下的垦殖活动成绩位列全国垦区之冠。",
    keywords: ["安汉", "西北垦殖", "抗战时期", "西北开发"],
    url: "https://oversea.cnki.net/kcms2/article/abstract?v=test&uniplatform=OVERSEA&language=CHS",
    extra: "CNKI exportId: TEST-EXPORT-ID-001",
  });

  const results = await addJsonItemsToZotero(
    [input],
    {
      zoteroLibraryId: "123456",
      zoteroLibraryType: "user",
      zoteroApiKey: "secret",
    },
    undefined,
    fetchMock,
  );

  assert.equal(results.length, 1);
  const result = results[0];
  assert.ok("itemKey" in result, "expected success result");
  assert.equal(result.itemKey, "FIX00001");
  assert.equal(result.source, "json");
  assert.equal(result.itemType, "journalArticle");

  const createRequest = requests.find((r) => /\/items$/u.test(r.url));
  assert.ok(createRequest);
  const body = JSON.parse(String(createRequest?.init?.body)) as Array<Record<string, unknown>>;
  const payload = body[0];
  assert.equal(payload?.title, "安汉与抗战时期西北垦殖运动");
  assert.equal(payload?.publicationTitle, "农业考古");
  assert.equal(payload?.DOI, "10.13568/j.cnki.test.2023.01.001");
  assert.equal(payload?.issue, "01");
  assert.equal(payload?.date, "2023");
  assert.equal(payload?.abstractNote?.toString().startsWith("安汉，陕西南郑人"), true);
  assert.equal(payload?.url, "https://oversea.cnki.net/kcms2/article/abstract?v=test&uniplatform=OVERSEA&language=CHS");
  assert.equal(payload?.extra, "CNKI exportId: TEST-EXPORT-ID-001");
  assert.deepEqual(payload?.creators, [
    { creatorType: "author", name: "储竞争" },
  ]);
  const tags = payload?.tags as Array<{ tag: string }>;
  assert.deepEqual(
    tags.map((t) => t.tag).sort(),
    ["Added by AI Agent", "西北垦殖", "西北开发", "抗战时期", "安汉"].sort(),
  );
});

test("addJsonItemsToZotero processes a batch of mixed item types", async () => {
  const { fetchMock, requests } = stubZotero({ itemKeys: ["B0001", "B0002", "B0003"] });
  const inputs = [
    mapLenientItem({
      itemType: "journalArticle",
      title: "Paper One",
      authors: ["Doe, Jane"],
      publicationTitle: "Journal A",
      year: "2024",
    }),
    mapLenientItem({
      itemType: "thesis",
      title: "Thesis Two",
      authors: ["李华"],
      university: "Test University",
      year: "2025",
    }),
    mapLenientItem({
      itemType: "journalArticle",
      title: "Paper Three",
      authors: ["Smith, John"],
      publicationTitle: "Journal B",
    }),
  ];
  const results = await addJsonItemsToZotero(
    inputs,
    {
      zoteroLibraryId: "123456",
      zoteroLibraryType: "user",
      zoteroApiKey: "secret",
    },
    undefined,
    fetchMock,
  );

  assert.equal(results.length, 3);
  for (const r of results) assert.ok("itemKey" in r, "all entries should be successful");
  assert.equal((results[0] as { itemKey: string }).itemKey, "B0001");
  assert.equal((results[1] as { itemKey: string }).itemKey, "B0002");
  assert.equal((results[2] as { itemKey: string }).itemKey, "B0003");
  assert.equal((results[1] as { itemType: string }).itemType, "thesis");

  const createRequests = requests.filter((r) => /\/items$/u.test(r.url));
  assert.equal(createRequests.length, 3);
  const journalBody = JSON.parse(String(createRequests[0].init?.body)) as Array<Record<string, unknown>>;
  assert.equal(journalBody[0]?.date, "2024", "year alias should land on Zotero date field");
  const thesisBody = JSON.parse(String(createRequests[1].init?.body)) as Array<Record<string, unknown>>;
  assert.equal(thesisBody[0]?.university, "Test University");
  assert.equal(thesisBody[0]?.date, "2025");
});

test("addJsonItemsToZotero passes a multi-collection array through unchanged", async () => {
  const { fetchMock, requests } = stubZotero({ itemKeys: ["M0001"] });
  const input = mapLenientItem({
    itemType: "journalArticle",
    title: "Multi-collection routing",
    collections: ["AAAAAAAA", "BBBBBBBB", "CCCCCCCC"],
  });

  await addJsonItemsToZotero(
    [input],
    {
      zoteroLibraryId: "123456",
      zoteroLibraryType: "user",
      zoteroApiKey: "secret",
    },
    undefined,
    fetchMock,
  );

  const createRequest = requests.find((r) => /\/items$/u.test(r.url));
  const body = JSON.parse(String(createRequest?.init?.body)) as Array<Record<string, unknown>>;
  assert.deepEqual(body[0]?.collections, ["AAAAAAAA", "BBBBBBBB", "CCCCCCCC"]);
});

test("mapLenientItem aliases the year field to Zotero's date", () => {
  const fromYear = mapLenientItem({ title: "Y", year: "2024" });
  assert.equal(fromYear.fields.date, "2024");
  assert.equal(fromYear.fields.year, undefined);

  const fromDate = mapLenientItem({ title: "D", date: "2024-07-15" });
  assert.equal(fromDate.fields.date, "2024-07-15");

  const both = mapLenientItem({ title: "B", date: "2024-07-15", year: "2024" });
  assert.equal(both.fields.date, "2024-07-15", "explicit date should win over year alias");
});

test("addJsonItemsToZotero normalizes the authors[] alias into creators", () => {
  const input = mapLenientItem({
    title: "T",
    authors: ["Doe, Jane", "李华", "Smith, John A."],
  });
  assert.deepEqual(input.fields.creators, [
    { creatorType: "author", firstName: "Jane", lastName: "Doe" },
    { creatorType: "author", name: "李华" },
    { creatorType: "author", firstName: "John A.", lastName: "Smith" },
  ]);
});

test("addJsonItemsToZotero converts keywords[] into tags and appends the agent tag", async () => {
  const { fetchMock, requests } = stubZotero({ itemKeys: ["K0001"] });
  const input = mapLenientItem({
    itemType: "journalArticle",
    title: "Keywords Test",
    keywords: ["国家治理", "边疆"],
  });

  await addJsonItemsToZotero(
    [input],
    {
      zoteroLibraryId: "123456",
      zoteroLibraryType: "user",
      zoteroApiKey: "secret",
    },
    undefined,
    fetchMock,
  );

  const createRequest = requests.find((r) => /\/items$/u.test(r.url));
  const body = JSON.parse(String(createRequest?.init?.body)) as Array<Record<string, unknown>>;
  const tags = body[0]?.tags as Array<{ tag: string }>;
  assert.deepEqual(tags, [
    { tag: "国家治理" },
    { tag: "边疆" },
    { tag: "Added by AI Agent" },
  ]);
});

test("mapLenientItem accepts lowercase abstract / doi aliases", () => {
  const input = mapLenientItem({
    title: "Aliases",
    abstract: "Short abstract.",
    doi: "10.1000/abc.def",
  });
  assert.equal(input.fields.abstractNote, "Short abstract.");
  assert.equal(input.fields.DOI, "10.1000/abc.def");
});

test("mapLenientItem rejects an item missing title", () => {
  assert.throws(
    () => mapLenientItem({ itemType: "journalArticle" }),
    /must include a non-empty 'title'/u,
  );
});

test("addJsonItemsToZotero returns a per-item error when Zotero rejects the itemType", async () => {
  const { fetchMock } = stubZotero({
    itemKeys: ["OK0001"],
    templateStatus: { bogus: 400 },
  });
  const inputs = [
    mapLenientItem({
      itemType: "journalArticle",
      title: "Good Item",
      authors: ["Doe, Jane"],
    }),
    mapLenientItem({
      itemType: "bogus",
      title: "Bad Item",
    }),
  ];

  const results = await addJsonItemsToZotero(
    inputs,
    {
      zoteroLibraryId: "123456",
      zoteroLibraryType: "user",
      zoteroApiKey: "secret",
    },
    undefined,
    fetchMock,
  );

  assert.equal(results.length, 2);
  assert.ok("itemKey" in results[0], "first item should succeed");
  assert.equal((results[0] as { itemKey: string }).itemKey, "OK0001");

  const failure = results[1];
  assert.ok("ok" in failure && failure.ok === false, "second item should fail");
  assert.equal(failure.error.code, "INVALID_ITEM_TYPE");
  assert.equal(failure.title, "Bad Item");
  assert.equal(failure.itemType, "bogus");
});

test("addJsonItemsToZotero CLI collection key overrides per-item collections", async () => {
  const { fetchMock, requests } = stubZotero({ itemKeys: ["C0001"] });
  const input = mapLenientItem({
    itemType: "journalArticle",
    title: "Routing Test",
    collections: ["AAAAAAAA"],
  });

  await addJsonItemsToZotero(
    [input],
    {
      zoteroLibraryId: "123456",
      zoteroLibraryType: "user",
      zoteroApiKey: "secret",
    },
    "BBBBBBBB",
    fetchMock,
  );

  const createRequest = requests.find((r) => /\/items$/u.test(r.url));
  const body = JSON.parse(String(createRequest?.init?.body)) as Array<Record<string, unknown>>;
  assert.deepEqual(body[0]?.collections, ["BBBBBBBB"]);
});

test("addJsonItemsToZotero passes through volume / issue / pages / ISSN", async () => {
  const { fetchMock, requests } = stubZotero({ itemKeys: ["P0001"] });
  const input = mapLenientItem({
    itemType: "journalArticle",
    title: "Passthrough Test",
    publicationTitle: "Some Journal",
    volume: "12",
    issue: "3",
    pages: "45-67",
    ISSN: "1234-5678",
  });

  await addJsonItemsToZotero(
    [input],
    {
      zoteroLibraryId: "123456",
      zoteroLibraryType: "user",
      zoteroApiKey: "secret",
    },
    undefined,
    fetchMock,
  );

  const createRequest = requests.find((r) => /\/items$/u.test(r.url));
  const body = JSON.parse(String(createRequest?.init?.body)) as Array<Record<string, unknown>>;
  assert.equal(body[0]?.volume, "12");
  assert.equal(body[0]?.issue, "3");
  assert.equal(body[0]?.pages, "45-67");
  assert.equal(body[0]?.ISSN, "1234-5678");
});
