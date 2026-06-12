# Zotagent

[![Version](https://img.shields.io/github/v/release/TomBener/zotagent?sort=semver&color=blue&label=Version)](https://github.com/TomBener/zotagent/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/TomBener/zotagent/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FTomBener%2Fzotagent%2Fmain%2Fpackage.json&query=%24.engines.node&label=Node.js&color=339933&logo=nodedotjs&logoColor=white)](https://nodejs.org/)

`zotagent` is a Zotero CLI for AI agents. 

## Features

`zotagent` is built around a local, agent-friendly Zotero index plus a small set of Zotero Web API helpers. Local lookup commands read artifacts under `dataDir`; API commands write or inspect the live Zotero library.

### Indexing

- `sync` — build or refresh local keyword, semantic, manifest, and normalized-markdown indexes from a Better CSL JSON bibliography and supported Zotero attachments: PDF, EPUB, HTML, and TXT.
- PDF extraction runs through [OpenDataLoader PDF](https://github.com/opendataloader-project/opendataloader-pdf), retries failed batches one PDF at a time, and falls back to text-only / `pdftotext` paths for known structural, empty-output, or timeout failures. EPUB and HTML are extracted in-process; TXT is indexed directly.
- Incremental sync skips unchanged ready files and unchanged extraction errors, unless `--retry-errors` is passed. It also detects attachments renamed or moved inside `attachmentsRoot` and migrates cached artifacts instead of re-extracting and re-embedding.
- Operational controls include `--attachments-root`, `--pdf-timeout-ms`, `--pdf-batch-size`, `--pdf-concurrency`, sync logs under `logs/`, `status` for index counts and paths, and `syncEnabled: false` for read-only hosts.
- Top-level Zotero items tagged `zotagent:exclude` are skipped entirely by sync (no extraction, no manifest, no keyword/qmd indexing) and removed from the local indexes on the next sync. The tag name can be customized via `excludeTag` in `~/.zotagent/config.json`.

### Search

- `search` — FTS5 keyword search (default) over indexed attachment text, with porter stemming and per-block ranking. Supports `"exact phrase"`, `OR`, `NOT`, `term NEAR/<n> term`, and `prefix*`. `--tag` restricts keyword search to top-level Zotero items with matching tags; `--collection-key` restricts to top-level items in a Zotero collection. Both flags are repeatable, combinable (intersection), and require a Zotero read API config.
- `search --semantic` — vector search over [QMD](https://github.com/tobi/qmd) embeddings with LLM query expansion; slower and heavier than keyword search. `--min-score` can filter both keyword and semantic results before mapping.
- CJK search is handled explicitly: Chinese, Japanese, and Korean text is segmented for FTS, Traditional Chinese is folded to Simplified at index and query time for keyword search, and exact CJK phrase matching remains accurate while returned text preserves the source form.
- `search-in` — scope a text query to one indexed item, addressed by `itemKey` or `citationKey` (auto-detected). It uses the same FTS5 syntax as `search` and adds a manifest-level cross-block scan for a single quoted phrase.
- `metadata` — search the Zotero bibliography (Better CSL JSON) across `title`, `author`, `year`, `abstract`, `journal`, and `publisher`. `--field` narrows the positional query; per-field filters (`--author`, `--year`, `--title`, `--journal`, `--publisher`) AND together and can replace the positional query entirely; `--tag` and `--collection-key` fetch matching top-level item keys from the Zotero Web API and filter locally (combinable with each other; intersection); `--has-file` keeps only items with supported attachments and `--abstract` opts into bulkier abstract output.
- Search results return compact passages centered on the hit, stable `itemKey`s, internal `charOffset`s for `expand`, and page hints (`pageStart` / `pageEnd`) when the extractor recorded them.

### Retrieve

- `blocks` — paginate one item's manifest chunks (paragraph / heading / list-item blocks) with `--offset-block` / `--limit-blocks`, including section paths and page hints when available.
- `fulltext` — return full normalized markdown for one item. `--clean` rebuilds text from the manifest while dropping duplicate blocks and common boilerplate such as citation notices and table-of-contents lines.
- `expand` — pull a continuous rendered-markdown slice around a search result's `charOffset`, with configurable `--radius` and returned passage bounds.

All three address an item by `--key`, which accepts either `itemKey` or `citationKey`. A leading `@` is stripped before dispatch, so Pandoc-style citations can be pasted directly. Values matching `[A-Z0-9]{8}` are dispatched as `itemKey`; anything else is treated as `citationKey`. When one item has multiple indexed attachments, they are merged into one logical document with monotonic `blockIndex` / `charOffset` coordinates and `# Attachment: <name>` dividers. Output always identifies items by `itemKey` only — citationKey is accepted as input but never emitted, so downstream chaining stays on a single stable key.

### Diagnostics

- `diagnose` — scan indexed manifests for anomalously fragmented extraction output, such as per-word English blocks, per-character vertical CJK, scanned non-OCR PDFs, or multi-column gazetteers. Apply the suggested Zotero tag (`excludeTag` to skip, `verticalTextTag` to re-extract with --reading-order=off) before re-syncing.

### Add to Zotero

- `add` — create Zotero items by DOI, by basic fields, from Semantic Scholar (`--s2-paper-id`), from a web page (`--from-url`), by identifier (`--identifier`), or by piping pre-shaped JSON via `--json` (single object or batch). New items are tagged `Added by AI Agent`, collection routing can come from config or `--collection-key`, and `add` returns the new `itemKey` immediately.
- `add --from-url` / `add --identifier` — run Zotero's site translators through a [translation-server](https://github.com/zotero/translation-server) instance (`translationServerUrl` in config). This is the same metadata extraction the Zotero browser connector performs: full field coverage, editors/translators, publisher keywords as tags, and translator notes as child notes (attachments are not saved — translation-server strips them; use `--attach-file` for a downloaded file). `--identifier` accepts DOI, ISBN, PMID, or arXiv ID — the CLI equivalent of Zotero's "Add Item by Identifier". When `translationServerUrl` is configured, `add --doi` also resolves through the server for richer metadata; without it, `--doi` uses doi.org CSL JSON as before.
- `add --json` — accepts lenient Zotero-like metadata (`authors`, `keywords`, `abstract`, `doi`, `year`, collections, and direct Zotero fields), returns an array in all cases, and reports per-item failures without aborting the rest of a batch.
- `--attach-file` / per-item `attachFile` — attach a local file as a Zotero `linked_file` child, with known content types for PDF, EPUB, HTML, and TXT. Paths under `attachmentsRoot` are stored with Zotero's portable `attachments:<rel>` form; invalid paths fail before parent creation.
- `s2` — search Semantic Scholar; pipe a returned `paperId` into `add --s2-paper-id`. Imported papers prefer DOI metadata when available and fall back to Semantic Scholar metadata otherwise.
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
  "zoteroApiKey": "<zotero-api-key>",
  "translationServerUrl": "http://127.0.0.1:1969"
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

- **`translationServerUrl`** — optional. Base URL of a [Zotero translation-server](https://github.com/zotero/translation-server) instance, e.g. `http://127.0.0.1:1969`. Start one locally with `docker run -d -p 1969:1969 --name translation-server zotero/translation-server`. Enables `add --from-url` and `add --identifier`, and upgrades `add --doi` to translator-grade metadata. Leave unset to keep the dependency-free doi.org path.

- **`verticalTextTag`** — optional override. Name of the Zotero tag that flags top-level items whose PDFs render text vertically (Republican Chinese books, Taiwan classical works). Items carrying the tag are extracted with `--reading-order=off` so the default xycut block ordering doesn't scramble columns. Defaults to `"zotagent:vertical"`; set this field only if you want a different name. Requires `zoteroApiKey` to be set; without credentials the tag is silently ignored.

- **`excludeTag`** — optional override. Name of the Zotero tag that flags top-level items you want sync to skip entirely (picture books, OCR-failed scans, multi-column gazetteers). Items carrying the tag are dropped from `catalogData` before extraction; previously-indexed entries are removed from keyword and qmd indexes on the next sync. Defaults to `"zotagent:exclude"`; set this field only if you want a different name. Requires `zoteroApiKey` to be set; without credentials the tag is silently ignored.

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
{ok: true, data, meta?}; failures are {ok: false, error: {code, message, details?}}
with exit code 1. Missing credentials fail fast with a JSON error. `sync` includes
`meta.elapsedMs` because it can be long-running.
Local search payloads (`search`, `search-in`, `metadata`) include `data.query`
once alongside `data.results`.

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
      Recognizes two Zotero tags by default (names customizable via
      `excludeTag` / `verticalTextTag` in ~/.zotagent/config.json):
        - `zotagent:exclude`: items skipped entirely (no extraction, no manifest,
          no keyword/qmd indexing). Use `zotagent diagnose` to find candidates.
        - `zotagent:vertical`: items extracted with --reading-order=off so
          vertical CJK columns don't get scrambled by xycut block ordering.
      Both tags are silently ignored if Zotero API credentials aren't configured.

  status
      Show attachment counts, local index paths, and qmd status.

  version, --version            Print the current zotagent version.
  help, --help                  Show this help. Also shown when no command is given.

  config
      Interactively set ~/.zotagent/config.json.

Search
  search "<text>" [--keyword | --semantic] [--limit <n>] [--min-score <n>] [--tag <tag>] [--collection-key <key>]
      Search indexed documents. Pass at most one of --keyword (default) or --semantic.
      Default is keyword search (FTS5 with porter stemming): "exact phrase", OR, NOT,
      term NEAR/<n> term, prefix*. Use NEAR/50 for proximity; NEAR(...) is not accepted.
      Chinese, Japanese, and Korean text is supported with accurate phrase matching.
      --semantic uses qmd vector search with LLM query expansion (slower, heavier).
        --limit <n>                 Return up to n search results. Default: 10 for search, 20 for metadata.
        --min-score <n>             Drop lower-scoring search hits before mapping.
        --tag <tag>                 Restrict keyword search to top-level Zotero items with this tag.
                                    Repeatable; requires Zotero read API config.
        --collection-key <key>      Restrict keyword search to top-level items directly in this Zotero
                                    collection. Repeatable (union); combinable with --tag (intersection);
                                    requires Zotero read API config.

  search-in "<text>" --key <key> [--limit <n>]
      Search within one indexed item's attachments. Uses the same FTS5 keyword
      syntax as `search`: "exact phrase", OR, NOT, term NEAR/<n> term, prefix*.
      Requires a populated keyword index (run `zotagent sync` first).

  metadata ["<text>"] [--limit <n>] [--field <field>] [--has-file] [--abstract]
           [--author <text>] [--year <text>] [--title <text>] [--journal <text>] [--publisher <text>]
           [--tag <tag>] [--collection-key <key>]
      Search Zotero bibliography metadata read from bibliographyJsonPath.
      Provide a positional query, one or more field filters, or both. The
      positional query is substring-matched across --field selections; each
      filter flag adds an AND constraint on that specific field. --tag and
      --collection-key fetch matching top-level item keys from the Zotero Web
      API, then filter locally.
        --field <field>             Limit the positional query to title, author, year, abstract,
                                    journal, or publisher. Repeatable.
        --author <text>             Filter by author substring.
        --year <text>               Filter by year substring (e.g. "1985", "198" for the 80s).
        --title <text>              Filter by title substring.
        --journal <text>            Filter by journal substring.
        --publisher <text>          Filter by publisher substring.
        --tag <tag>                 Filter by top-level Zotero item tag. Repeatable; requires
                                    Zotero read API config.
        --collection-key <key>      Filter by top-level items directly in this Zotero collection.
                                    Repeatable (union); combinable with --tag (intersection);
                                    requires Zotero read API config.
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

  expand --key <key> --offset <n> [--radius <n>]
      Return a continuous slice of the rendered markdown around a search-result
      `charOffset`.
        --offset <n>                Char offset to center on. Pass `charOffset` from a search result.
        --radius <n>                Half-window in characters. Default: 1000 (i.e. ~2000 char window).

Diagnostics
  diagnose [--limit <n>] [--all] [--threshold-avg <n>] [--threshold-median <n>]
      Scan all indexed manifests and surface documents whose extracted blocks
      look anomalously short — usually an upstream extraction failure (per-word
      English, per-character vertical CJK, scanned non-OCR PDFs, multi-column
      gazetteers). Output identifies the affected itemKeys so you can re-extract
      those PDFs (e.g. ocrmypdf, pdftotext -layout) and re-sync.
        --limit <n>                 Cap the result list. Default: 50.
        --all                       Include "ok" docs too. Default: only suspicious + borderline.
        --threshold-avg <n>         Suspicious avg-chars-per-block threshold. Default: 15.
        --threshold-median <n>      Suspicious median-chars-per-block threshold. Default: 10.

Document selector (used by search-in, blocks, fulltext, expand)
  --key <key>                   Resolve an item by itemKey or citationKey. A leading @ is
                                stripped before dispatch; values matching [A-Z0-9]{8} are
                                itemKey, anything else is citationKey. Output always
                                identifies items by itemKey only.

Add to Zotero
  add [--doi <doi> | --s2-paper-id <id> | --from-url <url> | --identifier <id> | --json <file|->]
      [--select <key>] [--title <text>] [--author <name>]
      [--year <text>] [--publication <text>] [--url <url>] [--url-date <date>]
      [--collection-key <key>] [--item-type <type>] [--attach-file <path>]
      Create one or many Zotero items and return their itemKeys. Prefer --doi when available.
      --s2-paper-id imports from Semantic Scholar (and still prefers DOI when present).
      --from-url and --identifier run Zotero's site translators through a configured
      translation-server (translationServerUrl) — the same metadata extraction the Zotero
      browser connector does, including publisher keywords as tags and translator notes as
      child notes (attachments are not saved; use --attach-file for a downloaded file).
      When translationServerUrl is set, --doi also resolves through it for richer
      metadata; otherwise --doi uses doi.org CSL JSON.
      --json reads pre-shaped JSON metadata from a file or stdin and is best for batch
      ingest from sources without working DOIs (e.g. CNKI). The JSON form is mutually
      exclusive with all other input flags except --collection-key.
        --doi <doi>                 Import from DOI metadata when possible.
        --s2-paper-id <id>          Import a Semantic Scholar paper by paperId.
        --from-url <url>            Translate a web page into an item via translation-server.
                                    If the page lists multiple candidates, add fails with
                                    MULTIPLE_RESULTS and details.choices; re-run with
                                    --select <key> to import one of them.
        --identifier <id>           Import by DOI, ISBN, PMID, or arXiv ID via
                                    translation-server (Zotero's "magic wand").
        --select <key>              Pick one candidate from a MULTIPLE_RESULTS response.
                                    Only valid with --from-url.
        --json <file|->             Read one JSON object or an array of JSON objects from
                                    a file or stdin (use '-'). Lenient Zotero schema:
                                    accepts authors[]/keywords[]/abstract/doi aliases plus
                                    direct Zotero field names. Always returns data: AddResult[].
                                    Per-item attachFile / attach-file field attaches a local
                                    file as a linked_file child (see --attach-file).
        --title <text>              Set title for manual add or DOI fallback.
        --author <name>             Add an author. Repeat for multiple authors.
        --year <text>               Set the Zotero date field.
        --publication <text>        Set journal, website, or container title when supported.
        --url <url>                 Set the item URL.
        --url-date <date>           Set the access date for the URL. Alias: --access-date.
        --collection-key <key>      Add the new item(s) to a Zotero collection by collection key.
                                    With --json this overrides any per-item collections field.
        --item-type <type>          Override the Zotero item type. Default: journalArticle or webpage.
        --attach-file <path>        Attach a local file as a linkMode=linked_file child (file
                                    stays on disk, no Zotero storage quota). When the path is
                                    under attachmentsRoot, zotagent stores it as 'attachments:<rel>'
                                    for cross-device portability; otherwise as an absolute path.
                                    Mutually exclusive with --json (use the per-item attachFile
                                    field there). Path is validated before the parent item is
                                    created. AddResult exposes attachmentItemKey on success.

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
- `add --from-url` / `--identifier` run against a translation-server, which fetches the raw page server-side: no JavaScript execution and no browser login session. Open-web pages and identifier lookups match what the browser connector extracts; paywalled or heavily scripted pages may translate worse (or not at all) — the in-browser connector remains the best tool there, and CNKI-style sources are still best served by `add --json`.
- Translation never saves attachments: translation-server strips attachment entries (PDF, snapshot) from translator output before zotagent sees them. To attach a file, download it yourself and pass `--attach-file`.
- `--tag` on `search` and `metadata` calls the Zotero Web API to resolve top-level item keys, then filters local results. Repeating `--tag` ANDs the tags. It requires Zotero read API config and applies to keyword search only; `--tag` cannot be combined with `search --semantic`.
- `search` returns a compact character-windowed `passage` centered on the hit and capped at 500 tokens; use `expand --key <key> --offset <charOffset>` to pull fuller context. Title-driven lookups belong in `metadata`, not `search`, because keyword search indexes attachment body text only. `metadata` omits `abstract` by default for the same compactness reason — pass `--abstract` to include it.
- Traditional Chinese is folded to simplified at both index and query time. This applies to `search`, `search-in`, and `metadata`; `search --semantic` does not fold. Returned text (`passage`, `blocks`, `fulltext`, `expand`) preserves the original form as stored in the attachment.
- `sync` skips files that fail extraction, records them as `error`, and continues. Re-runs skip unchanged errors; pass `--retry-errors` to retry. When an item has both a PDF and an EPUB, only the EPUB is indexed (both files stay attached in Zotero).
- `sync` recognizes two Zotero tags by default: `zotagent:exclude` (skip the item entirely; previously-indexed entries are removed from local keyword/qmd indexing on the next sync) and `zotagent:vertical` (extract the attached PDF with `--reading-order=off` for vertical CJK layouts). Override either name with `excludeTag` / `verticalTextTag` in `~/.zotagent/config.json`. Use `zotagent diagnose` to surface candidates for the exclude tag.
- `sync` detects attachments renamed or moved inside `attachmentsRoot` by matching `(itemKey, size, mtimeMs)` and migrates the cached `normalized/<docKey>.md` + `manifests/<docKey>.json.gz` to the new `docKey` — no re-extract, no re-embed.
- `sync` is crash-safe across indexer-state changes: the progress catalog keeps the previous embed model and indexer signature until stored vectors have actually been cleared, so interrupting `sync` never leaves the index in a "claims fresh / is stale" state.
- `search`, `blocks`, `fulltext`, and `expand` work entirely on the local index — run `sync` first when the library has changed.

### Adding from a web page or identifier (translation-server)

`add --from-url` and `add --identifier` reuse Zotero's own [translators](https://github.com/zotero/translators) — the ~600 site-specific extractors behind the browser connector's save button — by talking to a [translation-server](https://github.com/zotero/translation-server) instance. Compared to the doi.org CSL path, translator output carries the full Zotero field set (journal abbreviation, language, place, edition, editors/translators as proper creators), publisher keywords as tags, and translator notes as child notes.

Run the server once and point zotagent at it:

```bash
docker run -d -p 1969:1969 --name translation-server zotero/translation-server
# then set "translationServerUrl": "http://127.0.0.1:1969" in ~/.zotagent/config.json
```

Add directly from a page or an identifier:

```bash
# Any article / news / publisher page a Zotero translator understands
zotagent add --from-url "https://www.nature.com/articles/s41586-020-2649-2"

# DOI, ISBN, PMID, or arXiv ID — Zotero's "Add Item by Identifier"
zotagent add --identifier 9780691237558
zotagent add --identifier "arXiv:2406.01234"

# --doi automatically upgrades to the server when configured
zotagent add --doi "10.1111/dech.70058"
```

Pages that list multiple candidate items (search results, journal tables of contents) fail with `MULTIPLE_RESULTS` and a `details.choices` array of `{key, title}`; re-run the same command with `--select <key>` to import one candidate.

The manual flags (`--title`, `--author`, `--collection-key`, `--attach-file`, ...) compose with both paths and override the translated fields. The `AddResult` additionally exposes `noteItemKeys` when translator notes were created as child notes.

Because the server fetches raw HTML without a browser session, paywalled or JS-only pages may translate worse than the in-browser connector; identifier lookups (`--identifier`, `--doi`) are unaffected by this.

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

The output `data` is **always an array** of per-item results (even for a single-object input), so consumers don't need to branch on shape. Successful entries match the regular `AddResult` (`{itemKey, title, itemType, created, source: "json", attachmentItemKey?, warnings?}`); failed entries are returned in-place as `{ok: false, error: {code, message}, title?, itemType?}` and never abort the rest of the batch. The whole envelope is `{ok: false}` only on parse failures, missing config, or empty input.

`warnings` is **omitted when empty** (matching the `recent` / `metadata` output convention), so a clean run produces no `warnings` key at all. Consumers should treat the field as optional — `result.warnings?.length ?? 0` rather than `result.warnings.length`. Likewise `attachmentItemKey` is present only when an `attachFile` was provided and the linked attachment was created successfully.

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
| `attachFile` / `attach-file` | linked_file child item | Path to a local file to attach as a `linkMode: "linked_file"` child of the new parent. See `--attach-file` below. Bad paths fail the single item with code `INVALID_ATTACH_FILE` *before* the parent is created (no orphans). |
| Any other Zotero-native key | same key | `volume`, `issue`, `pages`, `ISSN`, `ISBN`, `extra`, `language`, `date`, `url`, `publisher`, `series`, `seriesNumber`, `shortTitle`, `libraryCatalog`, ... |

Every created item is auto-tagged `Added by AI Agent`, matching the other `add` paths.

### Attaching a local file (`--attach-file`)

```bash
zotagent add --title "Paper" --author "Doe, Jane" \
  --attach-file ~/Downloads/foo.pdf
```

This creates the parent item, then creates a child attachment with `linkMode: "linked_file"`. The file stays on disk — Zotero stores only a path reference, so your sync storage quota is unaffected. `AddResult` exposes both keys (`itemKey` for the parent, `attachmentItemKey` for the attachment).

For cross-device portability, set Zotero's *Linked Attachment Base Directory* (Settings → Files & Folders) to the same folder as `attachmentsRoot` in your zotagent config. When the attached path is under that root, zotagent stores it as `attachments:<rel>` (Zotero resolves it via the per-machine base directory) instead of an absolute path. Files outside the root are stored absolute and won't follow the database to another machine.

`--attach-file` is mutually exclusive with `--json`; in JSON mode each item carries its own `attachFile` (or `attach-file`) field. Path validation happens before any Zotero write, so a bad path can't leave an orphan parent item; if the parent succeeds but the attachment POST fails, the parent itemKey is still returned and the failure is recorded as a warning.

Supported `contentType` is inferred from the file extension (`pdf`, `epub`, `html`/`htm`, `txt`); unknown extensions fall through to `application/octet-stream` and Zotero handles them as generic attachments.

## Development

```bash
npm install
npm run check       # tsc --noEmit + node --test
npm run build       # tsc → dist/
npm run dev -- sync # run the CLI from source via tsx
```

## License

MIT. See [LICENSE](./LICENSE).
