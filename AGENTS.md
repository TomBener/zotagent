# zotagent Notes

## Project Goal

`zotagent` is a Zotero literature search CLI for AI agents.

Core design:

- internal primary key: `zotero-item-key`
- write operations should return `itemKey` immediately when possible
- `add` is speed-first and does not do Zotero-side duplicate checking
- external search results primarily return `itemKey + file`
- `citationKey` is a mutable display field only
- PDF extraction uses OpenDataLoader; EPUB and HTML are extracted in-process via jszip/linkedom/readability
- keyword search uses FTS5 with `porter unicode61` tokenizer (`keyword.sqlite`); supports AND, OR, NOT, NEAR, "phrase", prefix*
- semantic search uses qmd (vector + LLM query expansion via `qmd.sqlite`)
- `read` and `expand` do not depend on the search backend; they read local manifests directly

## Default Environment

- repo path: `~/Documents/GitHub/zotagent`
- bibliography: `~/Library/CloudStorage/Dropbox/bibliography/bibliography.json`
- attachments root: `~/Library/Mobile Documents/com~apple~CloudDocs/Zotero`
- data dir: `~/Library/Mobile Documents/com~apple~CloudDocs/Zotagent`
- config file: `~/.zotagent/config.json`
- optional qmd embedding model: controlled by `qmdEmbedModel`; when unset, qmd uses its default model
- Zotero write config for `add`: `zoteroLibraryId`, `zoteroLibraryType`, `zoteroApiKey`
- environment overrides for `add`: `ZOTAGENT_ZOTERO_LIBRARY_ID`, `ZOTAGENT_ZOTERO_LIBRARY_TYPE`, `ZOTAGENT_ZOTERO_API_KEY`
- fallback environment names also accepted for `add`: `ZOTERO_LIBRARY_ID`, `ZOTERO_LIBRARY_TYPE`, `ZOTERO_API_KEY`

Legacy fields `embeddingProvider`, `embeddingModel`, and `googleApiKey` may still appear in config, but they are only read for compatibility and produce deprecation warnings.

Long-lived indexes should remain in the iCloud-backed `dataDir`. Do not move persistent index files into `/tmp`. `/tmp` is only for tests or short-lived temporary work.

## Development Principles

- Avoid unnecessary fallbacks or compatibility layers. If you change CLI or config behavior, switch to the new behavior cleanly and update help text, tests, and docs in the same change.
- Keep compatibility only when a transition window has clear user value and the maintenance cost is justified.

## Useful Commands

```bash
npm run check
npm run build

node dist/cli.js sync
node dist/cli.js status
node dist/cli.js add --doi "10.1016/j.econmod.2026.107590"
node dist/cli.js add --title "Working Paper" --author "Jane Doe" --year 2026 --publication "Working Paper Series"
node dist/cli.js search "aging in China"
node dist/cli.js search "party secretary governance"
node dist/cli.js search '"aging in China" NOT famine'
node dist/cli.js search "govern*"
node dist/cli.js search "hukou NEAR migration"
node dist/cli.js search "political leadership corporate governance" --semantic
node dist/cli.js read --file "~/Library/.../paper.pdf"
node dist/cli.js expand --file "~/Library/.../paper.pdf" --block-start 10 --block-end 12
```

## Release Process

Use the GitHub CLI for releases.

Recommended release flow:

1. update `package.json` and `package-lock.json` to the target version
2. run `npm run check`
3. commit the release prep changes
4. create an annotated tag like `git tag -a v0.3.0 -m "v0.3.0"`
5. push `main` and the tag: `git push origin main && git push origin v0.3.0`
6. after the release workflow creates or updates the GitHub release, use `gh` to write the final changelog on the release page

Useful commands:

```bash
gh release view v0.2.0 --json body
gh release edit v0.3.0 --notes-file /tmp/zotagent-v0.3.0-notes.md
```

Release notes style:

- use short sections, similar to `v0.2.0`
- start with `## What's new`
- then add 1-3 focused sections only when they help
- keep the notes user-facing; avoid commit-by-commit changelogs
- mention command or behavior changes that affect users directly

## Code Map

- `src/cli.ts`: CLI entrypoint
- `src/add.ts`: Zotero Web API write flow for DOI import and basic manual item creation
- `src/config.ts`: config loading and path expansion
- `src/catalog.ts`: bibliography parsing and attachment mapping
- `src/manifest.ts`: conversion from ODL JSON or plain markdown into blocks, character ranges, and reference-like markers
- `src/epub.ts`: EPUB extraction (jszip + linkedom XHTML-to-markdown)
- `src/html-extract.ts`: HTML extraction (@mozilla/readability + linkedom)
- `src/keyword-db.ts`: FTS5 porter keyword index (keyword.sqlite)
- `src/exact.ts`: text normalization and exact phrase block-range mapping (used by keyword block locator)
- `src/qmd.ts`: qmd store adapter (semantic search backend)
- `src/sync.ts`: syncing, extraction, manifest writing, keyword index updates, and qmd updates
- `src/state.ts`: `catalog.json` reading, writing, and summary stats
- `src/engine.ts`: main flow for `search` (keyword + semantic), `read`, and `expand`
- `src/heuristics.ts`: reference-section and context-mapping heuristics
- `tests/unit/`: unit tests
- `tests/integration/`: CLI integration tests

## Current Add Logic

- `add --doi` fetches CSL JSON through DOI content negotiation, maps it into a Zotero item template, then creates the item through the Zotero Web API
- `add` does not do Zotero-side duplicate checking; this is intentional for speed
- if DOI lookup fails and manual fields are provided, `add` falls back to manual creation
- newly created items receive the tag `Added by AI Agent`
- `journalArticle` keeps `publicationTitle` but does not write `publisher`
- write responses should return `itemKey`, `title`, `itemType`, `source`, and optional `warnings`

## Current Search Logic

Two search modes, selected by CLI flags:

### Keyword Search (default, or `--keyword`)

- uses `keyword.sqlite` — FTS5 virtual table with `porter unicode61` tokenizer
- supports FTS5 query syntax: multi-word AND, `"exact phrase"`, OR, NOT, NEAR, NEAR/n, prefix*
- `sync` builds and incrementally maintains the keyword index
- if `keyword.sqlite` is missing at search time, it is lazily bootstrapped from existing manifests
- block locator: tries exact phrase match in manifest first, then falls back to stemmed term scoring per block (Porter stemmer in `engine.ts`), then title match
- reference-like hits are post-processed; substantive body hits are preferred
- ~100-200ms per query, ~few tens of MB memory

### Semantic Search (`--semantic`)

- uses `qmd.sqlite` — qmd hybrid search (BM25 + vector + LLM query expansion)
- qmd indexes `normalized/*.md` and stores per-document context such as `title + authors + year + abstract`
- maps `bestChunkPos` back to manifest blocks
- ~10-40s per query, ~4-5 GB memory (loads Qwen 1.7B + embedding model)

### Index Files

- `sync` produces one set of files per supported attachment (PDF, EPUB, HTML):
  - `normalized/<docKey>.md`
  - `manifests/<docKey>.json.gz`
  - `index/catalog.json`
  - `index/keyword.sqlite` (FTS5 keyword index)
  - `index/qmd.sqlite` (qmd semantic index)
- `read` and `expand` operate entirely on local manifests and do not depend on either search index

## Current Sync Logic

- every `sync` reloads the bibliography
- incremental decisions mainly depend on attachment `size`, `mtime`, and whether the expected index files already exist
- content changes trigger re-extraction and re-indexing for that attachment
- bibliography metadata is rewritten into `catalog.json`, keyword index, and qmd context on every sync
- `docKey = sha1(filePath)`, so renaming or moving an attachment behaves like "old path removed + new path added"

## Known Behavior

### 1. Reference Sections

Reference-like hits are post-processed, but not fully suppressed. Very short and broad queries can still return reference-section hits near the tail of the result list.

Relevant files:

- `src/heuristics.ts`
- `src/engine.ts`

### 2. Extraction Quality

OpenDataLoader can emit font, glyph, or encoding warnings for some PDFs. Common effects:

- a small number of character errors
- missing spaces
- occasional metadata mistakes

These issues come from the PDF and extraction chain, not from truncation in `zotagent`.

### 3. Context Slicing

The most common quality issue is usually not document recall. It is that a matched `passage` can be wider than ideal and may include title-page, copyright-page, or "to cite this article" material.

For keyword search, block mapping uses exact phrase matching first, then stemmed term scoring with boilerplate/TOC penalties. For semantic search, block mapping uses `bestChunkPos` from qmd.

## Search Change Guidance

- Validate search changes on a real indexed subset, not just unit tests
- Check at least:
  - whether the top result is sensible
  - whether one document dominates the first few slots
  - whether reference-only hits still leak upward
  - whether `passage` is polluted by title-page or front-matter text
  - whether `read` and `expand` still behave correctly

## Repository State

- the repository is already based on OpenDataLoader PDF + qmd
- the repository now includes an MIT `LICENSE` file
