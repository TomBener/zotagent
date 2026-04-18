# zotagent

[![Lint](https://github.com/TomBener/zotagent/actions/workflows/lint.yml/badge.svg?branch=main)](https://github.com/TomBener/zotagent/actions/workflows/lint.yml)
[![Release](https://github.com/TomBener/zotagent/actions/workflows/release.yml/badge.svg)](https://github.com/TomBener/zotagent/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/TomBener/zotagent/blob/main/LICENSE)

`zotagent` is a Zotero CLI for AI agents. 

## Features

- **Add to Zotero** — create items by DOI or basic fields and return the new `itemKey` immediately. `s2` searches Semantic Scholar and pipes a `paperId` into `add`.
- **Index local attachments** — `sync` extracts and indexes PDF, EPUB, HTML, and TXT files from a Zotero library. PDF extraction uses an OpenDataLoader cascade with `pdftotext` fallback; EPUB and HTML extraction runs in-process.
- **Search** — `search` runs FTS5 keyword search by default (`"exact phrase"`, `OR`, `NOT`, `NEAR`, prefix*) or semantic search with `--semantic` (qmd vector + LLM query expansion). Keyword search handles CJK (Chinese, Japanese, Korean) via character-level segmentation with `NEAR` proximity matching, and keeps only candidates verified by a phrase, term, or title hit to avoid FTS5 false positives. `search-in` scopes a query to a single document. `metadata` searches bibliography fields.
- **Read** — `read`, `fulltext`, and `expand` return blocks, full normalized markdown, or context around a hit, addressed by `itemKey` or `citationKey`. When one item has multiple indexed attachments, they are merged into a single logical document with monotonic block indices and `# Attachment: <name>` dividers.

All commands write JSON to stdout and are designed to be chained by AI agents.

## Installation

Requirements:

- Node.js `22+`
- JDK `11+` (only used by `sync` for PDF extraction)
- `pdftotext` (Poppler) is optional but recommended; `sync` uses it as a final fallback when OpenDataLoader fails

From source:

```bash
npm install
npm run check
npm run build
npm install -g .
```

Configure once at `~/.zotagent/config.json`:

```json
{
  "bibliographyJsonPath": "~/Library/CloudStorage/Dropbox/bibliography/bibliography.json",
  "attachmentsRoot": "~/Library/Mobile Documents/com~apple~CloudDocs/Zotero",
  "dataDir": "~/Library/Mobile Documents/com~apple~CloudDocs/Zotagent",
  "semanticScholarApiKey": "<api-key>",
  "zoteroLibraryId": "<library-id>",
  "zoteroLibraryType": "user",
  "zoteroCollectionKey": "<optional-collection-key>",
  "zoteroApiKey": "<api-key>"
}
```

`zoteroLibraryType` accepts `user` or `group`. `zoteroCollectionKey` is optional. The Semantic Scholar key is only needed for `s2` and `add --s2-paper-id`. Any of these can also come from environment variables (`ZOTAGENT_*` or unprefixed fallbacks like `ZOTERO_API_KEY`).

### Read-only hosts

If you share `dataDir` across machines (e.g. via iCloud) but keep the attachment files only on the machine that runs `sync`, set `"syncEnabled": false` in the other hosts' `~/.zotagent/config.json` (or export `ZOTAGENT_SYNC_ENABLED=false`). `sync` on those hosts fails fast with `SYNC_DISABLED` before touching the index — without this guard, a misfired `sync` would see every attachment as missing and wipe the keyword / semantic indexes. All read commands (`search`, `read`, `expand`, `fulltext`, `metadata`) still work.

## Usage

Run `zotagent help` for the full command reference. A typical session:

```bash
zotagent sync                                       # build or refresh the local index
zotagent add --doi "10.1111/dech.70058"             # add by DOI, returns itemKey
zotagent search "party secretary governance"        # FTS5 keyword search
zotagent search "aging in China" --semantic         # qmd semantic search
zotagent metadata "Development and Change" --field journal
zotagent read --item-key KG326EEI                   # read blocks from one document
zotagent expand --item-key KG326EEI --block-start 10 --radius 2
```

A few behaviors worth knowing:

- `add` does not deduplicate against your existing Zotero library — it is speed-first and returns `itemKey` immediately. New items are tagged `Added by AI Agent`.
- `sync` skips files that fail extraction, records them as `error`, and continues. Re-runs skip unchanged errors; pass `--retry-errors` to retry. When an item has both a PDF and an EPUB, only the EPUB is indexed (both files stay attached in Zotero).
- `search`, `read`, `fulltext`, and `expand` work entirely on the local index — run `sync` first when the library has changed.
- Every command emits JSON, including errors. Missing credentials fail fast.

## Development

```bash
npm install
npm run check       # tsc --noEmit + node --test
npm run build       # tsc → dist/
npm run dev -- sync # run the CLI from source via tsx
```

Project layout (high level):

- `src/cli.ts` — command parsing and dispatch
- `src/sync.ts` — extraction cascade, manifest writing, keyword/qmd index updates
- `src/engine.ts` — `search`, `read`, `expand`, `fulltext`
- `src/keyword-db.ts`, `src/qmd.ts` — keyword (FTS5) and semantic (qmd) backends
- `src/add.ts`, `src/s2.ts` — Zotero Web API and Semantic Scholar clients
- `tests/unit`, `tests/integration` — unit and CLI integration tests

## License

MIT. See [LICENSE](./LICENSE).
