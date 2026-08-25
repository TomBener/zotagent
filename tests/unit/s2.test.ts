import test from "node:test";
import assert from "node:assert/strict";

import {
  getSemanticScholarCitations,
  getSemanticScholarPaper,
  getSemanticScholarReferences,
  normalizeS2PaperId,
  parseRetryAfterMs,
  searchSemanticScholar,
  SemanticScholarError,
} from "../../src/s2.js";

const LINKED_FIELDS_QUERY =
  "fields=title%2Cauthors%2Cyear%2CexternalIds%2CpublicationTypes%2Cjournal%2Curl%2CopenAccessPdf%2CpublicationDate%2Cvenue%2CisInfluential";

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
    { limit: 5 },
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

test("normalizeS2PaperId canonicalizes every accepted identifier form", () => {
  const hex = "649def34f8be52c8b66281af98ae884c09aef38b";

  // Bare Semantic Scholar paperId, case-normalized.
  assert.equal(normalizeS2PaperId(hex), hex);
  assert.equal(normalizeS2PaperId(hex.toUpperCase()), hex);
  assert.equal(normalizeS2PaperId(`  ${hex}  `), hex);

  // Explicit prefixes: prefix canonicalized, payload preserved.
  assert.equal(normalizeS2PaperId("DOI:10.1093/ajae/aaq063"), "DOI:10.1093/ajae/aaq063");
  assert.equal(normalizeS2PaperId("doi:10.1093/ajae/aaq063"), "DOI:10.1093/ajae/aaq063");
  assert.equal(
    normalizeS2PaperId("DOI:https://doi.org/10.1093/ajae/aaq063"),
    "DOI:10.1093/ajae/aaq063",
  );
  assert.equal(normalizeS2PaperId("arxiv:2106.15928"), "ARXIV:2106.15928");
  assert.equal(normalizeS2PaperId("ARXIV:2106.15928v2"), "ARXIV:2106.15928");
  assert.equal(normalizeS2PaperId("pmid:19872477"), "PMID:19872477");
  assert.equal(normalizeS2PaperId("corpusid:37220927"), "CorpusId:37220927");
  assert.equal(
    normalizeS2PaperId("URL:https://arxiv.org/abs/2106.15928"),
    "URL:https://arxiv.org/abs/2106.15928",
  );

  // Unknown prefixes pass through untouched — Semantic Scholar owns the list.
  assert.equal(normalizeS2PaperId("MAG:112218234"), "MAG:112218234");
  assert.equal(normalizeS2PaperId("MAG: 112218234"), "MAG:112218234");
  assert.equal(normalizeS2PaperId("PMCID:PMC2323736"), "PMCID:PMC2323736");
  assert.equal(normalizeS2PaperId("ACL:W12-3903"), "ACL:W12-3903");

  // URLs.
  assert.equal(normalizeS2PaperId("https://doi.org/10.1093/ajae/aaq063"), "DOI:10.1093/ajae/aaq063");
  assert.equal(normalizeS2PaperId("http://dx.doi.org/10.1093/ajae/aaq063"), "DOI:10.1093/ajae/aaq063");
  assert.equal(normalizeS2PaperId("https://arxiv.org/abs/2106.15928"), "ARXIV:2106.15928");
  assert.equal(normalizeS2PaperId("https://arxiv.org/abs/2106.15928v2"), "ARXIV:2106.15928");
  assert.equal(normalizeS2PaperId("https://arxiv.org/pdf/2106.15928v2.pdf"), "ARXIV:2106.15928");
  // Browser junk after the id (query strings, fragments) never leaks into it.
  assert.equal(normalizeS2PaperId("https://arxiv.org/abs/2106.15928?context=cs"), "ARXIV:2106.15928");
  assert.equal(
    normalizeS2PaperId("https://doi.org/10.1093/ajae/aaq063?download=true#body"),
    "DOI:10.1093/ajae/aaq063",
  );
  assert.equal(normalizeS2PaperId(`https://www.semanticscholar.org/paper/Some-Title/${hex}`), hex);
  assert.equal(
    normalizeS2PaperId("https://www.semanticscholar.org/search?q=aging"),
    "URL:https://www.semanticscholar.org/search?q=aging",
  );

  // Bare identifiers.
  assert.equal(normalizeS2PaperId("10.1093/ajae/aaq063"), "DOI:10.1093/ajae/aaq063");
  assert.equal(normalizeS2PaperId("2106.15928"), "ARXIV:2106.15928");
  assert.equal(normalizeS2PaperId("2106.15928v3"), "ARXIV:2106.15928");
});

test("normalizeS2PaperId rejects anything that is not an identifier", () => {
  const rejected = [
    "",
    "   ",
    "Institutional change in rural China",
    "not-a-real-id",
    "PMID:abc",
    "CorpusId:12x",
    "URL:ftp://example.com/paper",
    "DOI:nope",
    "https://example.com/some/paper",
  ];

  for (const input of rejected) {
    assert.throws(
      () => normalizeS2PaperId(input),
      (error: unknown) => {
        assert.ok(
          error instanceof SemanticScholarError,
          `${JSON.stringify(input)} should raise SemanticScholarError`,
        );
        assert.equal(error.code, "INVALID_ARGUMENT");
        return true;
      },
    );
  }

  assert.throws(
    () => normalizeS2PaperId("not-a-real-id"),
    /Unrecognized paper identifier: not-a-real-id\./u,
  );
});

test("searchSemanticScholar skips degenerate rows instead of failing the command", async () => {
  const fetchMock: typeof fetch = async () =>
    jsonResponse({
      total: 3,
      data: [
        { paperId: "paper-1", title: "A Complete Row" },
        { paperId: "paper-2", title: null },
        null,
      ],
    });

  const result = await searchSemanticScholar(
    "active aging",
    { limit: 3 },
    { semanticScholarApiKey: "s2-secret" },
    fetchMock,
  );

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.paperId, "paper-1");
  assert.deepEqual(result.warnings, ["Skipped 2 entries with no Semantic Scholar record."]);
});

test("parseRetryAfterMs handles delta-seconds, HTTP-dates, and junk", () => {
  assert.equal(parseRetryAfterMs(null), 1000);
  assert.equal(parseRetryAfterMs(""), 1000);
  assert.equal(parseRetryAfterMs("0"), 0);
  assert.equal(parseRetryAfterMs("2"), 2000);
  assert.equal(parseRetryAfterMs("9999"), 10_000);
  assert.equal(parseRetryAfterMs("later"), 1000);
  assert.equal(parseRetryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT"), 0);

  const soon = parseRetryAfterMs(new Date(Date.now() + 3000).toUTCString());
  assert.ok(soon > 1000 && soon <= 3000, `unexpected wait for a near-future date: ${soon}`);
});

test("searchSemanticScholar passes offset and year through and echoes pagination", async () => {
  const requests: string[] = [];
  const fetchMock: typeof fetch = async (input) => {
    requests.push(String(input));
    return jsonResponse({
      total: 91,
      offset: 20,
      next: 25,
      data: [{ paperId: "paper-9", title: "Windowed Result" }],
    });
  };

  const result = await searchSemanticScholar(
    "active aging",
    { limit: 5, offset: 20, year: "2018-2020" },
    { semanticScholarApiKey: "s2-secret" },
    fetchMock,
  );

  assert.deepEqual(requests, [
    "https://api.semanticscholar.org/graph/v1/paper/search?query=active+aging&limit=5&offset=20&year=2018-2020&fields=title%2Cauthors%2Cyear%2CexternalIds%2CpublicationTypes%2Cjournal%2Curl%2CopenAccessPdf%2CpublicationDate%2Cvenue%2Cabstract",
  ]);
  assert.equal(result.total, 91);
  assert.equal(result.offset, 20);
  assert.equal(result.next, 25);
  assert.equal(result.results.length, 1);
});

test("getSemanticScholarReferences maps cited papers and skips records S2 lacks", async () => {
  const requests: string[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    requests.push(String(input));
    assert.equal(new Headers(init?.headers).get("x-api-key"), "s2-secret");
    return jsonResponse({
      offset: 0,
      next: 50,
      data: [
        {
          isInfluential: true,
          citedPaper: {
            paperId: "cited-1",
            title: "Cited Paper One",
            authors: [{ name: "Ada Lovelace" }],
            year: 2009,
            externalIds: { DOI: "10.1000/cited-one" },
            publicationTypes: ["JournalArticle"],
            journal: { name: "Reference Quarterly" },
            venue: "Reference Quarterly",
            publicationDate: "2009-04-01",
            url: "https://www.semanticscholar.org/paper/cited-1",
            openAccessPdf: { url: "https://example.com/cited-one.pdf" },
            abstract: "Should never be requested, and never emitted.",
          },
        },
        { isInfluential: false, citedPaper: null },
        { citedPaper: { title: "Bibliography stub with no paperId" } },
      ],
    });
  };

  const result = await getSemanticScholarReferences(
    "DOI:10.1093/ajae/aaq063",
    { limit: 50, offset: 0 },
    { semanticScholarApiKey: "s2-secret" },
    fetchMock,
  );

  // '/' and ':' stay literal in the path; only the fields commas are encoded.
  assert.deepEqual(requests, [
    `https://api.semanticscholar.org/graph/v1/paper/DOI:10.1093/ajae/aaq063/references?offset=0&limit=50&${LINKED_FIELDS_QUERY}`,
  ]);
  assert.equal(result.paperId, "DOI:10.1093/ajae/aaq063");
  assert.equal(result.offset, 0);
  assert.equal(result.next, 50);
  assert.deepEqual(result.warnings, ["Skipped 2 entries with no Semantic Scholar record."]);
  assert.deepEqual(result.results, [
    {
      paperId: "cited-1",
      title: "Cited Paper One",
      authors: ["Ada Lovelace"],
      year: "2009",
      doi: "10.1000/cited-one",
      venue: "Reference Quarterly",
      journal: "Reference Quarterly",
      publicationDate: "2009-04-01",
      publicationTypes: ["JournalArticle"],
      url: "https://www.semanticscholar.org/paper/cited-1",
      openAccessPdfUrl: "https://example.com/cited-one.pdf",
      isInfluential: true,
    },
  ]);
  assert.ok(!("abstract" in result.results[0]!), "reference rows must not carry an abstract");
});

test("getSemanticScholarCitations reads the citingPaper side and omits absent flags", async () => {
  const requests: string[] = [];
  const fetchMock: typeof fetch = async (input) => {
    requests.push(String(input));
    return jsonResponse({
      offset: 10,
      data: [
        {
          isInfluential: false,
          citingPaper: { paperId: "citing-1", title: "Citing Paper One" },
        },
      ],
    });
  };

  const result = await getSemanticScholarCitations(
    "ARXIV:2106.15928",
    { limit: 5, offset: 10 },
    { semanticScholarApiKey: "s2-secret" },
    fetchMock,
  );

  assert.deepEqual(requests, [
    `https://api.semanticscholar.org/graph/v1/paper/ARXIV:2106.15928/citations?offset=10&limit=5&${LINKED_FIELDS_QUERY}`,
  ]);
  assert.equal(result.offset, 10);
  assert.equal(result.next, undefined);
  assert.equal(result.warnings, undefined);
  assert.deepEqual(result.results, [
    {
      paperId: "citing-1",
      title: "Citing Paper One",
      authors: [],
      publicationTypes: [],
    },
  ]);
});

test("Semantic Scholar requests retry a 429 and then succeed", async () => {
  let calls = 0;
  const fetchMock: typeof fetch = async () => {
    calls += 1;
    if (calls <= 2) {
      return new Response(JSON.stringify({ message: "Too Many Requests", code: "429" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "retry-after": "0" },
      });
    }
    return jsonResponse({ offset: 0, data: [{ citedPaper: { paperId: "p", title: "T" } }] });
  };

  const result = await getSemanticScholarReferences(
    "DOI:10.1000/retry",
    { limit: 1, offset: 0 },
    { semanticScholarApiKey: "s2-secret" },
    fetchMock,
  );

  assert.equal(calls, 3);
  assert.equal(result.results.length, 1);
});

test("Semantic Scholar requests fail with RATE_LIMITED once retries run out", async () => {
  let calls = 0;
  const fetchMock: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ message: "Too Many Requests", code: "429" }), {
      status: 429,
      headers: { "Content-Type": "application/json", "retry-after": "0" },
    });
  };

  await assert.rejects(
    () =>
      getSemanticScholarCitations(
        "DOI:10.1000/retry",
        { limit: 1, offset: 0 },
        { semanticScholarApiKey: "s2-secret" },
        fetchMock,
      ),
    (error: unknown) => {
      assert.ok(error instanceof SemanticScholarError);
      assert.equal(error.code, "RATE_LIMITED");
      return true;
    },
  );
  assert.equal(calls, 3);
});
