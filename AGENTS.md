# zotlit Notes

## Project Goal

`zotlit` is a Zotero literature search CLI for AI agents.

Core design:

- internal primary key: `zotero-item-key`
- write operations should return `itemKey` immediately when possible
- `add` is speed-first and does not do Zotero-side duplicate checking
- external search results primarily return `itemKey + file`
- `citationKey` is a mutable display field only
- current v1 scope is `PDF` only
- PDF extraction uses OpenDataLoader
- search uses `qmd`
- `read` and `expand` do not depend on the search backend; they read local manifests directly
- the external search interface stays unified instead of splitting keyword search and semantic search into separate commands

## Default Environment

- repo path: `~/Documents/GitHub/zotlit`
- bibliography: `~/Library/CloudStorage/Dropbox/bibliography/bibliography.json`
- attachments root: `~/Library/Mobile Documents/com~apple~CloudDocs/Zotero`
- data dir: `~/Library/Mobile Documents/com~apple~CloudDocs/Zotlit`
- config file: `~/.zotlit/config.json`
- optional qmd embedding model: controlled by `qmdEmbedModel`; when unset, qmd uses its default model
- Zotero write config for `add`: `zoteroLibraryId`, `zoteroLibraryType`, `zoteroApiKey`
- environment overrides for `add`: `ZOTLIT_ZOTERO_LIBRARY_ID`, `ZOTLIT_ZOTERO_LIBRARY_TYPE`, `ZOTLIT_ZOTERO_API_KEY`
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
gh release edit v0.3.0 --notes-file /tmp/zotlit-v0.3.0-notes.md
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
- `src/manifest.ts`: conversion from ODL JSON into blocks, character ranges, and reference-like markers
- `src/qmd.ts`: qmd store adapter
- `src/sync.ts`: syncing, extraction, manifest writing, and qmd updates
- `src/state.ts`: `catalog.json` reading, writing, and summary stats
- `src/engine.ts`: main flow for `search`, `read`, and `expand`
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

- `sync` produces one set of files per PDF:
  - `normalized/<docKey>.md`
  - `manifests/<docKey>.json`
  - `index/catalog.json`
- qmd indexes `normalized/*.md` and stores per-document context such as `title + authors + year + abstract`
- `search` calls qmd's unified search, then maps `bestChunkPos` back to manifest blocks
- reference-like hits still receive post-processing; when body-text candidates exist, they are preferred over reference-only hits
- `read` and `expand` operate entirely on local manifests and do not depend on qmd

## Current Sync Logic

- every `sync` reloads the bibliography
- incremental decisions mainly depend on attachment `size`, `mtime`, and whether the expected index files already exist
- content changes trigger re-extraction and re-indexing for that PDF
- bibliography metadata is rewritten into `catalog.json` and qmd context on every sync
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

These issues come from the PDF and extraction chain, not from truncation in `zotlit`.

### 3. Context Slicing

The most common quality issue is usually not document recall. It is that a matched `passage` can be wider than ideal and may include title-page, copyright-page, or "to cite this article" material.

If you want to improve citation-oriented usefulness, prioritize:

- `bestChunkPos -> block range` mapping
- lower weight for front-matter, copyright, and table-of-contents style blocks
- extra weight for explicit heading hits when appropriate

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
