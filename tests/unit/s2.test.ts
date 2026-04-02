import test from "node:test";
import assert from "node:assert/strict";

import { getSemanticScholarPaper, searchSemanticScholar } from "../../src/s2.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

test("searchSemanticScholar maps results and sends the API key header", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });

    if (url === "https://api.semanticscholar.org/graph/v1/paper/search?query=active+aging&limit=5&fields=title%2Cauthors%2Cyear%2CexternalIds%2CpublicationTypes%2Cjournal%2Curl%2CopenAccessPdf%2CpublicationDate%2Cvenue%2Cabstract") {
      return jsonResponse({
        total: 1,
        data: [
          {
            paperId: "paper-1",
            title: "Active Aging Study",
            authors: [{ name: "Ada Lovelace" }, { name: "Grace Hopper" }],
            year: 2025,
            externalIds: { DOI: "10.1000/aging" },
            publicationTypes: ["JournalArticle"],
            journal: { name: "Frontiers in Public Health" },
            venue: "Frontiers in Public Health",
            publicationDate: "2025-01-03",
            url: "https://www.semanticscholar.org/paper/paper-1",
            openAccessPdf: { url: "https://example.com/paper.pdf" },
            abstract: "Testing",
          },
        ],
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await searchSemanticScholar(
    "active aging",
    5,
    {
      semanticScholarApiKey: "s2-secret",
    },
    fetchMock,
  );

  assert.equal(result.total, 1);
  assert.deepEqual(result.results, [
    {
      paperId: "paper-1",
      title: "Active Aging Study",
      authors: ["Ada Lovelace", "Grace Hopper"],
      year: "2025",
      doi: "10.1000/aging",
      venue: "Frontiers in Public Health",
      journal: "Frontiers in Public Health",
      publicationDate: "2025-01-03",
      publicationTypes: ["JournalArticle"],
      url: "https://www.semanticscholar.org/paper/paper-1",
      openAccessPdfUrl: "https://example.com/paper.pdf",
      abstract: "Testing",
    },
  ]);
  assert.equal(
    new Headers(requests[0]?.init?.headers).get("x-api-key"),
    "s2-secret",
  );
});

test("getSemanticScholarPaper returns full paper metadata", async () => {
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);

    assert.equal(
      new Headers(init?.headers).get("x-api-key"),
      "s2-secret",
    );
    assert.equal(
      url,
      "https://api.semanticscholar.org/graph/v1/paper/paper-2?fields=title%2Cauthors%2Cyear%2CexternalIds%2CpublicationTypes%2Cjournal%2Curl%2CopenAccessPdf%2CpublicationDate%2Cvenue%2Cabstract",
    );

    return jsonResponse({
      paperId: "paper-2",
      title: "Paper Two",
      authors: [{ name: "Jane Doe" }],
      year: 2026,
      externalIds: { DOI: "10.1000/paper-two" },
      publicationTypes: ["JournalArticle"],
      journal: { name: "Testing Quarterly" },
      publicationDate: "2026-02-01",
      url: "https://www.semanticscholar.org/paper/paper-2",
      abstract: "Full paper metadata",
    });
  };

  const result = await getSemanticScholarPaper(
    "paper-2",
    {
      semanticScholarApiKey: "s2-secret",
    },
    fetchMock,
  );

  assert.deepEqual(result.paper, {
    paperId: "paper-2",
    title: "Paper Two",
    authors: ["Jane Doe"],
    year: "2026",
    doi: "10.1000/paper-two",
    journal: "Testing Quarterly",
    publicationDate: "2026-02-01",
    publicationTypes: ["JournalArticle"],
    url: "https://www.semanticscholar.org/paper/paper-2",
    abstract: "Full paper metadata",
  });
});
