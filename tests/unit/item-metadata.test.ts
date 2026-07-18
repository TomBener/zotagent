import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanDoi,
  determineDoiItemType,
  extractTitle,
  formatIssuedDate,
  mapCslAuthors,
  mapManualAuthors,
} from "../../src/item-metadata.js";

// One row per CSL/CrossRef work type the DOI path must translate. The table
// covers both vocabularies (CSL 1.0 and the CrossRef types that leak into
// DOI content-negotiated CSL JSON) plus the two special cases and the
// document fallback.
const typeRows: Array<{ csl: Record<string, unknown>; want: string }> = [
  { csl: { type: "article-journal" }, want: "journalArticle" },
  { csl: { type: "journal-article" }, want: "journalArticle" },
  { csl: { type: "paper-conference" }, want: "conferencePaper" },
  { csl: { type: "proceedings-article" }, want: "conferencePaper" },
  { csl: { type: "chapter" }, want: "bookSection" },
  { csl: { type: "book-chapter" }, want: "bookSection" },
  { csl: { type: "book-part" }, want: "bookSection" },
  { csl: { type: "book-section" }, want: "bookSection" },
  { csl: { type: "book" }, want: "book" },
  { csl: { type: "edited-book" }, want: "book" },
  { csl: { type: "monograph" }, want: "book" },
  { csl: { type: "reference-book" }, want: "book" },
  { csl: { type: "report" }, want: "report" },
  { csl: { type: "thesis" }, want: "thesis" },
  { csl: { type: "webpage" }, want: "webpage" },
  { csl: { type: "post-weblog" }, want: "webpage" },
  { csl: { type: "article-magazine" }, want: "magazineArticle" },
  { csl: { type: "article-newspaper" }, want: "newspaperArticle" },
  // Special cases for the bare "article" type CrossRef uses for preprints.
  { csl: { type: "article", publisher: "arXiv" }, want: "preprint" },
  { csl: { type: "article", URL: "https://arxiv.org/abs/2401.00001" }, want: "preprint" },
  { csl: { type: "article", "container-title": "Some Journal" }, want: "journalArticle" },
  // Unknown or absent types fall back to the safest generic type.
  { csl: { type: "article" }, want: "document" },
  { csl: { type: "dataset" }, want: "document" },
  { csl: {}, want: "document" },
];

for (const row of typeRows) {
  test(`determineDoiItemType: ${JSON.stringify(row.csl)} → ${row.want}`, () => {
    assert.equal(determineDoiItemType(row.csl), row.want);
  });
}

test("cleanDoi strips doi: and doi.org prefixes and trailing slashes", () => {
  assert.equal(cleanDoi("doi:10.1000/xyz123"), "10.1000/xyz123");
  assert.equal(cleanDoi("https://doi.org/10.1000/xyz123"), "10.1000/xyz123");
  assert.equal(cleanDoi("https://dx.doi.org/10.1000/xyz123/"), "10.1000/xyz123");
  assert.equal(cleanDoi("10.1000%2Fxyz123"), "10.1000/xyz123");
});

test("cleanDoi rejects strings that are not DOIs", () => {
  assert.throws(() => cleanDoi(""), /Invalid DOI/);
  assert.throws(() => cleanDoi("not-a-doi"), /Invalid DOI/);
  assert.throws(() => cleanDoi("https://example.com/10"), /Invalid DOI/);
});

test("extractTitle joins subtitle and derives the short title", () => {
  assert.deepEqual(extractTitle({ title: "Main", subtitle: "Sub" }), {
    fullTitle: "Main: Sub",
    shortTitle: "Main",
  });
  assert.deepEqual(extractTitle({ title: "Main" }), { fullTitle: "Main" });
  assert.deepEqual(extractTitle({ title: "Main", "short-title": "M" }), {
    fullTitle: "Main",
    shortTitle: "M",
  });
  assert.deepEqual(extractTitle({}), { fullTitle: "" });
});

test("formatIssuedDate pads year-month-day parts and stops at non-integers", () => {
  assert.equal(formatIssuedDate({ "date-parts": [[2026, 7, 18]] }), "2026-07-18");
  assert.equal(formatIssuedDate({ "date-parts": [[2026, 7]] }), "2026-07");
  assert.equal(formatIssuedDate({ "date-parts": [[826]] }), "0826");
  assert.equal(formatIssuedDate({ "date-parts": [["2026"]] }), "");
  assert.equal(formatIssuedDate(undefined), "");
});

test("mapManualAuthors handles comma form, space form, and single names", () => {
  assert.deepEqual(mapManualAuthors(["Ho, Peter", "Anna Maria Busse Berger", "司马迁"]), [
    { creatorType: "author", firstName: "Peter", lastName: "Ho" },
    { creatorType: "author", firstName: "Anna Maria Busse", lastName: "Berger" },
    { creatorType: "author", name: "司马迁" },
  ]);
});

test("mapCslAuthors prefers family/given and falls back to literal", () => {
  assert.deepEqual(
    mapCslAuthors({
      author: [
        { family: "Scott", given: "James C." },
        { literal: "地质调查所" },
        { irrelevant: true },
      ],
    }),
    [
      { creatorType: "author", firstName: "James C.", lastName: "Scott" },
      { creatorType: "author", name: "地质调查所" },
    ],
  );
});
