# Zotagent

[![Version](https://img.shields.io/github/v/release/TomBener/zotagent?sort=semver&color=blue&label=Version)](https://github.com/TomBener/zotagent/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/TomBener/zotagent/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FTomBener%2Fzotagent%2Fmain%2Fpackage.json&query=%24.engines.node&label=Node.js&color=339933&logo=nodedotjs&logoColor=white)](https://nodejs.org/)

`zotagent` is a Zotero CLI for AI agents. 

## Features

Search and retrieval are the core features. Both read from a local index that `sync` builds from PDF, EPUB, HTML, and TXT attachments in a Zotero library — PDFs via an OpenDataLoader cascade with `pdftotext` fallback; EPUB and HTML extracted in-process.

### Search

- `search` — FTS5 keyword search (default) with porter stemming. Supports `"exact phrase"`, `OR`, `NOT`, `term NEAR/<n> term`, and `prefix*`. Chinese, Japanese, and Korean (CJK) text is supported with accurate phrase matching and built-in false-positive filtering.
- `search --semantic` — vector search over [qmd](https://github.com/tobi/qmd) embeddings with LLM query expansion; slower and heavier than keyword search.
- `search-in` — scope a text query to a single indexed item's attachments, addressed by `itemKey` or `citationKey` (auto-detected).
- `metadata` — search the Zotero bibliography (Better CSL JSON) across `title`, `author`, `year`, `abstract`, `journal`, and `publisher`. `--field` narrows the fields the positional query hits; per-field filters (`--author`, `--year`, `--title`, `--journal`, `--publisher`) AND together and can replace the positional query entirely (e.g. `metadata --author "Pratt" --year "1985"`); `--has-file` keeps only items with an indexed attachment.

### Retrieve

- `blocks` — paginate blocks from one item's manifest with `--offset-block` / `--limit-blocks`.
- `fulltext` — return the full normalized markdown for one item. `--clean` drops duplicate blocks and common boilerplate (citation notices, TOC lines).
- `expand` — pull context around a block range, typically a search hit, with a configurable `--radius`.

All three address an item by `--key`, which accepts either `itemKey` or `citationKey`. A leading `@` is stripped before dispatch, so Pandoc-style citations can be pasted directly. Values matching `[A-Z0-9]{8}` are dispatched as `itemKey`; anything else is treated as `citationKey`. When one item has multiple indexed attachments, they are merged into one logical document with monotonic block indices and `# Attachment: <name>` dividers. Output always identifies items by `itemKey` only — citationKey is accepted as input but never emitted, so downstream chaining stays on a single stable key.

### Add to Zotero

- `add` — create an item by DOI, by basic fields, or by piping pre-shaped JSON via `--json` (single object or batch). Returns the new `itemKey` immediately.
- `s2` — search Semantic Scholar; pipe a returned `paperId` into `add --s2-paper-id`.
- `recent` — list regular top-level items most recently added or modified, straight from the Zotero Web API (no local index needed). Useful for confirming an `add` landed or orienting an agent in the library.

All commands write JSON to stdout and are designed to be chained by AI agents.

## Installation

Install `zotagent` with Homebrew:

```bash
brew install TomBener/tap/zotagent
```
Install the `zotagent` skill:

```bash
npx skills add TomBener/zotagent
```

Configure once — run the interactive wizard, or hand-edit `~/.zotagent/config.json`:

```bash
zotagent config
```

The wizard prompts for each basic field, uses the current value (if any) as default, masks secrets, and writes the file. If you'd rather edit it directly, the shape is:

```json
{
  "bibliographyJsonPath": "~/Library/CloudStorage/Dropbox/bibliography/bibliography.json",
  "attachmentsRoot": "~/Library/Mobile Documents/com~apple~CloudDocs/Zotero",
  "dataDir": "~/Library/Mobile Documents/com~apple~CloudDocs/Zotagent",
  "semanticScholarApiKey": "<semantic-scholar-key>",
  "zoteroLibraryId": "<library-id>",
  "zoteroLibraryType": "user",
  "zoteroCollectionKey": "<optional-collection-key>",
  "zoteroApiKey": "<zotero-api-key>"
}
```

Where each field comes from:

- **`bibliographyJsonPath`** — a **Better CSL JSON** export produced by the [Better BibTeX for Zotero](https://retorque.re/zotero-better-bibtex) plugin. See the `zotero-item-key` note below before your first export.

- **`attachmentsRoot`** — the root folder where Zotero keeps attachment files. For linked attachments, use the path configured at Zotero → Settings → Files and Folders → "Linked Attachment Base Directory". For stored attachments, this is typically `~/Zotero/storage`.

- **`dataDir`** — where zotagent writes its index, manifests, and normalized markdown. Point this at an iCloud / Dropbox folder to share the cached index across machines (see the read-only-hosts tip below).

- **`zoteroLibraryId`** and **`zoteroLibraryType`** — open [zotero.org/settings/security](https://www.zotero.org/settings/security); your numeric userID is shown at the top of the "Applications" section. Use `"user"` with that userID for a personal library, or `"group"` with the group ID (visible under Groups) for a shared library.

- **`zoteroApiKey`** — required by `recent`, `add`, and `add --s2-paper-id`. Create one at [zotero.org/settings/keys/new](https://www.zotero.org/settings/keys/new) with library read access for `recent`; grant write access too if you use `add`.

- **`zoteroCollectionKey`** — optional. 8-character key of a collection that `add` will drop new items into. Open the collection in the Zotero web library (`zotero.org/<user>/collections/<key>`); the last segment is the key.

- **`semanticScholarApiKey`** — required by `s2` and `add --s2-paper-id`; other commands ignore it. Request one from the "API Key Form" on [semanticscholar.org/product/api](https://www.semanticscholar.org/product/api#api-key) (approval typically takes a few business days).

Any of these can also come from environment variables (`ZOTAGENT_*` or unprefixed fallbacks like `ZOTERO_API_KEY`).

> [!IMPORTANT]
> **Better CSL JSON omits `zotero-item-key` by default, and zotagent silently skips any item without it.** Add this one-line postscript at Edit → Preferences → Better BibTeX → Export → Postscript, then set the auto-export trigger to `On Change` so `bibliography.json` stays in sync with the library without manual re-exports:
>
> ```javascript
> if (Translator.BetterCSLJSON) {
>   csl["zotero-item-key"] = zotero.key;
> }
> ```

> [!TIP]
> **Read-only hosts:** If you share `dataDir` across machines (e.g. via iCloud) but keep the attachment files only on the machine that runs `sync`, set `"syncEnabled": false` in the other hosts' `~/.zotagent/config.json` (or export `ZOTAGENT_SYNC_ENABLED=false`). `sync` on those hosts fails fast with `SYNC_DISABLED` before touching the index — without this guard, a misfired `sync` would see every attachment as missing and wipe the keyword / semantic indexes. All local lookup commands (`search`, `blocks`, `expand`, `fulltext`, `metadata`) still work.

## Usage

`zotagent help` prints the full command reference:

```text
zotagent — Zotero CLI for AI agents.

Usage: zotagent <command> [flags]

All commands emit pretty-printed JSON on stdout. Success payloads are
{ok: true, data, meta?}; failures are {ok: false, error: {code, message, details?},
meta?} with exit code 1. Missing credentials fail fast with a JSON error.

Index
  sync [--attachments-root <path>] [--retry-errors] [--pdf-timeout-ms <n>] [--pdf-batch-size <n>]
       [--pdf-concurrency <n>]
      Build or refresh the local index of PDF, EPUB, HTML, and TXT attachments.
      Unchanged extraction errors are skipped by default; pass --retry-errors to retry them.
        --attachments-root <path>   Index only a Zotero subfolder.
        --retry-errors              Retry unchanged files that failed extraction earlier.
        --pdf-timeout-ms <n>        Override the OpenDataLoader timeout for each PDF extraction call.
        --pdf-batch-size <n>        Override the maximum number of PDFs per extraction batch.
        --pdf-concurrency <n>       Run N extraction batches in parallel (default 2). Each batch
                                    spawns its own java process; tune with available CPU and RAM.

  status
      Show attachment counts, local index paths, and qmd status.

  version, --version            Print the current zotagent version.
  help, --help                  Show this help. Also shown when no command is given.

  config
      Interactively set ~/.zotagent/config.json.

Search
  search "<text>" [--keyword | --semantic] [--limit <n>] [--min-score <n>]
      Search indexed documents. Pass at most one of --keyword (default) or --semantic.
      Default is keyword search (FTS5 with porter stemming): "exact phrase", OR, NOT,
      term NEAR/<n> term, prefix*. Use NEAR/50 for proximity; NEAR(...) is not accepted.
      Chinese, Japanese, and Korean text is supported with accurate phrase matching.
      --semantic uses qmd vector search with LLM query expansion (slower, heavier).
        --limit <n>                 Return up to n search results. Default: 10 for search, 20 for metadata.
        --min-score <n>             Drop lower-scoring search hits before mapping.

  search-in "<text>" --key <key> [--limit <n>]
      Search within one indexed item's attachments (exact phrase and term match).

  metadata ["<text>"] [--limit <n>] [--field <field>] [--has-file] [--abstract]
           [--author <text>] [--year <text>] [--title <text>] [--journal <text>] [--publisher <text>]
      Search Zotero bibliography metadata read from bibliographyJsonPath.
      Provide a positional query, one or more field filters, or both. The
      positional query is substring-matched across --field selections; each
      filter flag adds an AND constraint on that specific field.
        --field <field>             Limit the positional query to title, author, year, abstract,
                                    journal, or publisher. Repeatable.
        --author <text>             Filter by author substring.
        --year <text>               Filter by year substring (e.g. "1985", "198" for the 80s).
        --title <text>              Filter by title substring.
        --journal <text>            Filter by journal substring.
        --publisher <text>          Filter by publisher substring.
        --has-file                  Keep only metadata results with a supported indexed attachment.
        --abstract                  Include the abstract in each result. Omitted by default to keep
                                    bulk responses compact for agents.

Retrieval
  blocks --key <key> [--offset-block <n>] [--limit-blocks <n>]
      Return paginated blocks from one indexed item.
      When one item has multiple indexed attachments, they are merged into one logical
      document with monotonic block indices and "# Attachment: <name>" dividers between them.
        --offset-block <n>          Start at block n. Default: 0.
        --limit-blocks <n>          Return up to n blocks. Default: 20.

  fulltext --key <key> [--clean]
      Output agent-friendly full text for one item. Multi-attachment items return one
      merged markdown document.
        --clean                     Apply heuristic cleanup (drops duplicate blocks and
                                    common boilerplate such as citation notices and TOC lines).

  expand --key <key> --block-start <n> [--block-end <n>] [--radius <n>]
      Expand around a search hit or block range from a local manifest.
      Block indices are item-global; feed blockStart from search results directly.
        --block-start <n>           Start block for expand.
        --block-end <n>             End block for expand. Default: block-start.
        --radius <n>                Include n blocks before and after. Default: 2.

Document selector (used by search-in, blocks, fulltext, expand)
  --key <key>                   Resolve an item by itemKey or citationKey. A leading @ is
                                stripped before dispatch; values matching [A-Z0-9]{8} are
                                itemKey, anything else is citationKey. Output always
                                identifies items by itemKey only.

Add to Zotero
  add [--doi <doi> | --s2-paper-id <id> | --json <file|->] [--title <text>] [--author <name>]
      [--year <text>] [--publication <text>] [--url <url>] [--url-date <date>]
      [--collection-key <key>] [--item-type <type>]
      Create one or many Zotero items and return their itemKeys. Prefer --doi when available.
      --s2-paper-id imports from Semantic Scholar (and still prefers DOI when present).
      --json reads pre-shaped JSON metadata from a file or stdin and is best for batch
      ingest from sources without working DOIs (e.g. CNKI). The JSON form is mutually
      exclusive with all other input flags except --collection-key.
        --doi <doi>                 Import from DOI metadata when possible.
        --s2-paper-id <id>          Import a Semantic Scholar paper by paperId.
        --json <file|->             Read one JSON object or an array of JSON objects from
                                    a file or stdin (use '-'). Lenient Zotero schema:
                                    accepts authors[]/keywords[]/abstract/doi aliases plus
                                    direct Zotero field names. Always returns data: AddResult[].
        --title <text>              Set title for manual add or DOI fallback.
        --author <name>             Add an author. Repeat for multiple authors.
        --year <text>               Set the Zotero date field.
        --publication <text>        Set journal, website, or container title when supported.
        --url <url>                 Set the item URL.
        --url-date <date>           Set the access date for the URL. Alias: --access-date.
        --collection-key <key>      Add the new item(s) to a Zotero collection by collection key.
                                    With --json this overrides any per-item collections field.
        --item-type <type>          Override the Zotero item type. Default: journalArticle or webpage.

  s2 "<text>" [--limit <n>]
      Search Semantic Scholar; pass a returned paperId to `add --s2-paper-id`.

  recent [--limit <n>] [--sort added|modified]
      List regular top-level Zotero items most recently added or modified.
      Fetches live from the Zotero Web API; does not require a sync. Skips
      standalone notes and attachments. Returns itemKey plus title, authors,
      year, type, dateAdded, and dateModified.
        --limit <n>                 Return up to n items. Default: 10. Max: 100.
        --sort added|modified       Sort by dateAdded (default) or dateModified.
```

A few behaviors worth knowing:

- `add` does not deduplicate against your existing Zotero library — it is speed-first and returns `itemKey` immediately. New items are tagged `Added by AI Agent`.
- `search` truncates each hit's `passage` at 500 tokens so bulk results stay compact regardless of language; use `expand` to pull full context around a block range. `metadata` omits `abstract` by default for the same reason — pass `--abstract` to include it.
- Traditional Chinese is folded to simplified at both index and query time, so 黨組書記 and 党组书记 match each other. This applies to `search`, `search-in`, and `metadata`; `search --semantic` does not fold. Returned text (`passage`, `blocks`, `fulltext`, `expand`) preserves the original form as stored in the attachment.
- `sync` skips files that fail extraction, records them as `error`, and continues. Re-runs skip unchanged errors; pass `--retry-errors` to retry. When an item has both a PDF and an EPUB, only the EPUB is indexed (both files stay attached in Zotero).
- `sync` detects attachments renamed or moved inside `attachmentsRoot` by matching `(itemKey, size, mtimeMs)` and migrates the cached `normalized/<docKey>.md` + `manifests/<docKey>.json.gz` to the new `docKey` — no re-extract, no re-embed.
- `sync` is crash-safe across indexer-state changes: the progress catalog keeps the previous embed model and indexer signature until stored vectors have actually been cleared, so interrupting `sync` never leaves the index in a "claims fresh / is stale" state.
- `search`, `blocks`, `fulltext`, and `expand` work entirely on the local index — run `sync` first when the library has changed.

### Adding items from JSON (`add --json`)

Use `add --json` when the source already produces structured metadata — for example a CNKI extractor that pulls title, abstract, keywords, and DOI out of a paper detail page. CNKI papers often carry CNKI-issued DOIs that don't resolve via CrossRef, so `add --doi` doesn't help; `add --json` lets the extractor hand the metadata over directly.

Single object (file):

```bash
zotagent add --json paper.json
```

Batch (array in a file):

```bash
zotagent add --json papers.json --collection-key COLL1234
```

Stdin pipe:

```bash
cat papers.json | zotagent add --json -
your-extractor | zotagent add --json -
```

`--json` is exclusive with `--doi`, `--s2-paper-id`, and the manual flags (`--title`, `--author`, `--year`, `--publication`, `--url`, `--url-date`, `--access-date`, `--item-type`). Only `--collection-key` may accompany `--json`; when set, it overrides any per-item `collections` field in the input.

The output `data` is **always an array** of per-item results (even for a single-object input), so consumers don't need to branch on shape. Successful entries match the regular `AddResult` (`{itemKey, title, itemType, created, source: "json", warnings[]}`); failed entries are returned in-place as `{ok: false, error: {code, message}, title?, itemType?}` and never abort the rest of the batch. The whole envelope is `{ok: false}` only on parse failures, missing config, or empty input.

#### Lenient input schema

Every key below is optional except `title`. `itemType` defaults to `journalArticle`. Unknown Zotero-native keys (e.g. `extra`, `language`, `series`) pass through and are silently dropped if the resolved Zotero template doesn't expose them.

| Input field | Maps to | Notes |
|---|---|---|
| `itemType` | `itemType` | Defaults to `"journalArticle"`. Validated by Zotero `/items/new`; an unknown type fails the single item with `INVALID_ITEM_TYPE`. |
| `title` | `title` | **Required.** |
| `creators` | `creators` (pass-through) | Array of `{creatorType, firstName?, lastName?, name?}`. |
| `authors` | `creators` | Array of strings. `"Last, First"` and `"First Last"` are split; single tokens (incl. CJK like `"李华"`) become `{creatorType: "author", name: "<token>"}`. If both `creators` and `authors` are present, `creators` wins and a warning is added. |
| `tags` | `tags` (pass-through) | Array of `{tag}` objects or plain strings. Strings are wrapped to `{tag}`. |
| `keywords` | `tags` | Array of strings → `[{tag: "..."}]`. If both `tags` and `keywords` are present, `tags` wins and a warning is added. |
| `abstractNote` / `abstract` | `abstractNote` | First non-empty wins. |
| `DOI` / `doi` | `DOI` | Run through the same DOI cleaner the manual path uses. Invalid DOIs are dropped with a warning; the item is still created. |
| `publicationTitle` / `publication` / `journal` | container field | Routed through `applyPublicationField` so book / conference / website item types pick the right container (`bookTitle`, `proceedingsTitle`, `websiteTitle`). |
| `accessDate` / `access-date` / `accessedAt` | `accessDate` | First non-empty wins. |
| `date` / `year` | `date` | First non-empty wins. Zotero stores the publication date in `date` (free-form string), not `year`; passing only `year` would be silently dropped without this alias. |
| `university` | `university` | Pass-through (relevant for `itemType: "thesis"`). |
| `collections` / `collectionKey` | `collections` | A string or string array. **Multi-collection arrays pass through unchanged**, so an item can land in several collections at once. CLI `--collection-key` overrides per-item collections (forces a single key for the whole batch); when CLI is unset and no per-item value is provided, the configured `zoteroCollectionKey` default is used. |
| Any other Zotero-native key | same key | `volume`, `issue`, `pages`, `ISSN`, `ISBN`, `extra`, `language`, `date`, `url`, `publisher`, `series`, `seriesNumber`, `shortTitle`, `libraryCatalog`, ... |

Every created item is auto-tagged `Added by AI Agent`, matching the other `add` paths.

## Development

```bash
npm install
npm run check       # tsc --noEmit + node --test
npm run build       # tsc → dist/
npm run dev -- sync # run the CLI from source via tsx
```

## License

MIT. See [LICENSE](./LICENSE).
