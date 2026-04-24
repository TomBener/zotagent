import test from "node:test";
import assert from "node:assert/strict";

import { listRecentItems } from "../../src/recent.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

test("listRecentItems skips standalone notes and attachments while paging to the requested limit", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });

    if (url === "https://api.zotero.org/users/123456/items/top?sort=dateAdded&direction=desc&limit=2&start=0") {
      return jsonResponse([
        {
          data: {
            key: "NOTE0001",
            itemType: "note",
            title: "Standalone note",
            dateAdded: "2026-04-23T10:00:00Z",
            dateModified: "2026-04-23T10:00:00Z",
          },
        },
        {
          data: {
            key: "ATTACH01",
            itemType: "attachment",
            title: "Standalone PDF",
            dateAdded: "2026-04-23T09:00:00Z",
            dateModified: "2026-04-23T09:00:00Z",
          },
        },
      ]);
    }

    if (url === "https://api.zotero.org/users/123456/items/top?sort=dateAdded&direction=desc&limit=2&start=2") {
      return jsonResponse([
        {
          data: {
            key: "ITEM0001",
            itemType: "journalArticle",
            title: "Recent Article",
            creators: [
              {
                firstName: "Jane",
                lastName: "Doe",
              },
              {
                name: "Research Collective",
              },
            ],
            date: "Spring 2025",
            dateAdded: "2026-04-23T08:00:00Z",
            dateModified: "2026-04-23T08:30:00Z",
          },
          meta: {
            parsedDate: "2025-04-01",
          },
        },
        {
          data: {
            key: "ITEM0002",
            itemType: "book",
            title: "Recent Book",
            creators: [
              {
                lastName: "Smith",
              },
            ],
            date: "2020",
            dateAdded: "2026-04-22T08:00:00Z",
            dateModified: "2026-04-22T08:30:00Z",
          },
        },
      ]);
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await listRecentItems(
    {
      limit: 2,
      sort: "dateAdded",
    },
    {
      zoteroLibraryId: "123456",
      zoteroLibraryType: "user",
      zoteroApiKey: "secret",
    },
    fetchMock,
  );

  assert.deepEqual(result.results, [
    {
      itemKey: "ITEM0001",
      title: "Recent Article",
      authors: ["Jane Doe", "Research Collective"],
      year: "2025",
      type: "journalArticle",
      dateAdded: "2026-04-23T08:00:00Z",
      dateModified: "2026-04-23T08:30:00Z",
    },
    {
      itemKey: "ITEM0002",
      title: "Recent Book",
      authors: ["Smith"],
      year: "2020",
      type: "book",
      dateAdded: "2026-04-22T08:00:00Z",
      dateModified: "2026-04-22T08:30:00Z",
    },
  ]);
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "https://api.zotero.org/users/123456/items/top?sort=dateAdded&direction=desc&limit=2&start=0",
      "https://api.zotero.org/users/123456/items/top?sort=dateAdded&direction=desc&limit=2&start=2",
    ],
  );
  assert.equal(new Headers(requests[0]?.init?.headers).get("Zotero-API-Key"), "secret");
});

test("listRecentItems uses group library URLs and dateModified sorting", async () => {
  const fetchMock: typeof fetch = async (input) => {
    assert.equal(
      String(input),
      "https://api.zotero.org/groups/7890/items/top?sort=dateModified&direction=desc&limit=1&start=0",
    );
    return jsonResponse([
      {
        data: {
          key: "ITEM0003",
          itemType: "report",
          title: "Recent Report",
          creators: [],
          dateAdded: "2026-04-20T08:00:00Z",
          dateModified: "2026-04-23T08:30:00Z",
        },
      },
    ]);
  };

  const result = await listRecentItems(
    {
      limit: 1,
      sort: "dateModified",
    },
    {
      zoteroLibraryId: "7890",
      zoteroLibraryType: "group",
      zoteroApiKey: "secret",
    },
    fetchMock,
  );

  assert.equal(result.results[0]?.itemKey, "ITEM0003");
});
