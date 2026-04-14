# zotlit

[![Lint](https://github.com/TomBener/zotlit/actions/workflows/lint.yml/badge.svg?branch=main)](https://github.com/TomBener/zotlit/actions/workflows/lint.yml)
[![Release](https://github.com/TomBener/zotlit/actions/workflows/release.yml/badge.svg)](https://github.com/TomBener/zotlit/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/TomBener/zotlit/blob/main/LICENSE)

`zotlit` is a Zotero CLI for AI agents.

It focuses on a small set of tasks:

- add a Zotero item and return its `itemKey`
- search Semantic Scholar papers and import one into Zotero
- index local Zotero attachments (PDF, EPUB, HTML)
- search indexed documents
- search bibliography metadata
- read, expand, or export agent-friendly full text by `itemKey`, `citationKey`, or file

## Features

- `add`
  Create a Zotero item from DOI metadata or basic fields.
- `s2`
  Search Semantic Scholar and pass a paperId into `add`.
- `sync`
  Build or refresh the local index (PDF, EPUB, HTML).
- `search`
  Search indexed documents with default no-rerank hybrid search, optional `--rerank`, or `--exact` lexical search.
- `metadata`
  Search bibliography metadata without running `sync`.
- `read` / `fulltext` / `expand`
  Read blocks from local manifests, export full markdown for agents, and expand around a hit.

Current scope:

- PDF, EPUB, and HTML attachments
- local indexing and search
- Zotero Web API writes for item creation

## Requirements

- Node.js `22+`
- JDK `11+`

Notes:

- `sync` uses Java during PDF extraction; EPUB and HTML extraction runs in-process without Java
- `sync` skips files that time out or fail extraction, records them as `error`, and continues the rest of the batch
- `sync` skips unchanged extraction errors on later runs; use `--retry-errors` to force another attempt
- `sync` extracts books, chapters, `/Book/` attachments, and large PDFs one at a time instead of batching them with other PDFs
- `sync` writes a readable log file to `dataDir/logs/` and refreshes `dataDir/logs/sync-latest.log`
- qmd may prepare local models on first use

## Install

From source:

```bash
npm install
npm run check
npm run build
npm install -g .
```

## Config

Default config file:

- `~/.zotlit/config.json`

Minimal example:

```json
{
  "bibliographyJsonPath": "~/Library/CloudStorage/Dropbox/bibliography/bibliography.json",
  "attachmentsRoot": "~/Library/Mobile Documents/com~apple~CloudDocs/Zotero",
  "dataDir": "~/Library/Mobile Documents/com~apple~CloudDocs/Zotlit",
  "semanticScholarApiKey": "<api-key>",
  "zoteroLibraryId": "<library-id>",
  "zoteroLibraryType": "user",
  "zoteroCollectionKey": "<optional-collection-key>",
  "zoteroApiKey": "<api-key>"
}
```

API credentials can also come from environment variables:

- `ZOTLIT_SEMANTIC_SCHOLAR_API_KEY`
- `ZOTLIT_ZOTERO_LIBRARY_ID`
- `ZOTLIT_ZOTERO_LIBRARY_TYPE`
- `ZOTLIT_ZOTERO_COLLECTION_KEY`
- `ZOTLIT_ZOTERO_API_KEY`

Fallback environment variable names:

- `SEMANTIC_SCHOLAR_API_KEY`
- `ZOTERO_LIBRARY_ID`
- `ZOTERO_LIBRARY_TYPE`
- `ZOTERO_COLLECTION_KEY`
- `ZOTERO_API_KEY`

`semanticScholarApiKey` is only needed for `zotlit s2` and `zotlit add --s2-paper-id`.
`zoteroCollectionKey` is optional and sets the default collection for new items created by `add`.
`zoteroLibraryType` supports both `user` and `group`.
`sync` treats bibliography attachment paths as relocatable under `attachmentsRoot`, so a bibliography exported on another machine still matches local PDFs when the relative path under the Zotero root is the same. Catalog paths under the local home directory are stored as `~/...`, so an iCloud-backed `dataDir` can be shared across Macs with different usernames.

## Commands

```bash
zotlit sync [--attachments-root <path>] [--retry-errors] [--pdf-timeout-ms <n>] [--pdf-batch-size <n>]
zotlit status
zotlit version
zotlit add [--doi <doi> | --s2-paper-id <id>] [--title <text>] [--author <name>] [--year <text>] [--publication <text>] [--url <url>] [--url-date <date>] [--collection-key <key>] [--item-type <type>]
zotlit s2 "<text>" [--limit <n>]
zotlit search "<text>" [--exact] [--limit <n>] [--min-score <n>] [--rerank]
zotlit search-in "<text>" (--file <path> | --item-key <key> | --citation-key <key>) [--limit <n>]
zotlit metadata "<text>" [--limit <n>] [--field <field>] [--has-file]
zotlit read (--file <path> | --item-key <key> | --citation-key <key>) [--offset-block <n>] [--limit-blocks <n>]
zotlit fulltext (--file <path> | --item-key <key> | --citation-key <key>) [--clean]
zotlit expand (--file <path> | --item-key <key> | --citation-key <key>) --block-start <n> [--block-end <n>] [--radius <n>]
```

## Common Usage

Add by DOI:

```bash
zotlit add --doi "10.1111/dech.70058"
```

Search Semantic Scholar and import by paperId:

```bash
zotlit s2 "active aging in China" --limit 5
zotlit add --s2-paper-id "f2005ed06241e8aa6f55f7ed9279a56b92038128"
```

Add by fields:

```bash
zotlit add \
  --title "Working Paper Title" \
  --author "Jane Doe" \
  --year 2026 \
  --collection-key "ABCD1234" \
  --publication "Working Paper Series" \
  --url "https://example.com/paper" \
  --url-date "2026-04-02"
```

Group library example:

```json
{
  "zoteroLibraryId": "<group-id>",
  "zoteroLibraryType": "group",
  "zoteroApiKey": "<api-key>"
}
```

Build or refresh the local index:

```bash
zotlit sync
```

Retry unchanged extraction errors:

```bash
zotlit sync --retry-errors
```

Extract every PDF one at a time:

```bash
zotlit sync --pdf-batch-size 1
```

Give large PDFs a longer per-extraction timeout:

```bash
zotlit sync --pdf-timeout-ms 600000
```

Search indexed documents:

```bash
zotlit search "state-owned enterprise governance"
zotlit search "dangwei shuji" --exact
zotlit search "how do party secretaries shape SOE governance" --rerank
```

Default `search` skips qmd reranking for lower latency. Use `--rerank` only for narrower queries when ranking quality matters more than speed.

Search within one indexed document:

```bash
zotlit search-in "dangwei shuji" --item-key KG326EEI
zotlit search-in "firm governance" --file "~/Library/.../paper.pdf" --limit 5
```

Follow a search hit with `read`, `fulltext`, or `expand`:

```bash
zotlit search "dangwei shuji" --exact
zotlit read --item-key KG326EEI
zotlit read --citation-key lee2024aging
zotlit fulltext --item-key KG326EEI
zotlit fulltext --item-key KG326EEI --clean
zotlit expand --item-key KG326EEI --block-start 10 --radius 2
```

Search metadata:

```bash
zotlit metadata "Development and Change" --field journal
```

Read and expand:

```bash
zotlit read --item-key KG326EEI
zotlit read --citation-key lee2024aging
zotlit fulltext --item-key KG326EEI
zotlit fulltext --item-key KG326EEI --clean
zotlit fulltext --file "~/Library/.../paper.pdf"
zotlit expand --item-key KG326EEI --block-start 10 --radius 2
zotlit expand --file "~/Library/.../paper.pdf" --block-start 10 --radius 2
```

## Notes

- `add` returns `itemKey` immediately, so an agent can cite the item right away.
- `add --s2-paper-id` prefers DOI import when Semantic Scholar returns a DOI, and falls back to Semantic Scholar metadata when it does not.
- `add` writes to the library root by default. Set `zoteroCollectionKey` in config or pass `--collection-key <key>` to place new items in a collection.
- New items created by `add` receive the tag `Added by AI Agent`.
- Creating an item in Zotero does not make it instantly searchable in local PDF search. `metadata` depends on your exported bibliography JSON, and PDF search depends on `sync`.
- `search`, `read`, `fulltext`, and `expand` only work on the local index. Run `zotlit sync` first when attachments or manifests are stale.
- `search-in` limits the search scope to one selected document, or to all matching attachments when one `itemKey` or `citationKey` maps to multiple indexed documents.
- `fulltext` returns `results[]`. When one `itemKey` or `citationKey` maps to multiple indexed documents, all matching attachments are included instead of raising a conflict.
- `fulltext` returns the original normalized markdown by default, without content filtering.
- `fulltext --clean` applies heuristic cleanup, including duplicate-block removal and common boilerplate filtering.
- Missing Zotero or Semantic Scholar credentials fail fast with explicit config errors instead of partial results.
- `journalArticle` items keep `publicationTitle` but do not write `publisher`.

## License

MIT. See [LICENSE](./LICENSE).
