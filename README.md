# Zotagent

[![Version](https://img.shields.io/github/v/release/TomBener/zotagent?sort=semver&color=blue&label=Version)](https://github.com/TomBener/zotagent/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/TomBener/zotagent/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FTomBener%2Fzotagent%2Fmain%2Fpackage.json&query=%24.engines.node&label=Node.js&color=339933&logo=nodedotjs&logoColor=white)](https://nodejs.org/)

`zotagent` is a Zotero CLI for AI agents. It builds a local full-text index of your Zotero attachments (PDF, EPUB, HTML, TXT) for keyword and semantic search, and wraps the Zotero Web API and Semantic Scholar for adding items and following citations. Every command writes JSON to stdout, so agents can chain them.

## Features

### Index

- `sync` builds or refreshes the local index from a Better CSL JSON bibliography and the attachment files: a keyword index (SQLite FTS5), a semantic index ([QMD](https://github.com/tobi/qmd)), and the normalized markdown and block manifests behind them.
- PDFs go through [OpenDataLoader PDF](https://github.com/opendataloader-project/opendataloader-pdf), falling back to text-only extraction and then `pdftotext` when a file fails, times out, or yields too little text. A scan with no OCR text layer, or a PDF whose broken fonts extract to noise, is recorded as an `error` rather than indexed. HTML is decoded by its BOM or declared charset, so GBK pages read correctly, and TXT honours a BOM. When an item has both a PDF and an EPUB, only the EPUB is indexed.
- Re-runs are incremental. Unchanged files are skipped, including earlier extraction errors unless you pass `--retry-errors`; a file whose mtime changed but whose content did not (an iCloud or Dropbox re-download) reuses its cached artifacts; and an attachment renamed or moved inside `attachmentsRoot` keeps its artifacts instead of being re-extracted and re-embedded.
- Two Zotero tags on top-level items steer sync: `zotagent:exclude` skips an item and removes it from the indexes, and `zotagent:vertical` extracts a vertical CJK PDF with `--reading-order=off`. `diagnose` flags fragmented extraction output, which is how you find candidates for either tag.
- `status` reports index counts and paths. Sync logs go to `logs/` under `dataDir`.

### Search

- `search` — keyword search over attachment body text (titles are not indexed; use `metadata`). Supports `"exact phrase"`, `OR`, `NOT`, `term NEAR/<n> term`, and `prefix*`. `--tag` and `--collection-key` restrict it to tagged items or a collection; a filter that matches nothing adds a warning, so a misspelled tag doesn't pass for an empty result.
- `search --semantic` — vector search with LLM query expansion. Slower than keyword search, and it does not take `--tag`, `--collection-key`, or `--min-score`.
- `search-in` — keyword search within one item.
- `metadata` — search the bibliography by title, author, year, journal, publisher, or abstract, with per-field filters, `--tag` / `--collection-key`, and `--indexed` to keep only items whose full text is in the index. Titles and journal names are matched and returned without Zotero's rich-text markup, so `--title "Chiang Kai-shek"` finds a title stored as `Chiang Kai-<span class="nocase">shek</span>`.
- CJK text is segmented for keyword search, and an unquoted CJK run matches as a phrase (`会社` never matches `社会`). Traditional Chinese is folded to Simplified, and ligatures and full-width characters to their plain forms, on both the index and the query side (`search`, `search-in`, `metadata`; not `--semantic`). Returned text keeps its original form.
- Results carry a short passage around the hit, a stable `itemKey`, a `charOffset` for `expand`, and page hints (`pageStart` / `pageEnd`) where the extractor recorded them. Page hints are positions in the PDF file counted from 1, not printed page numbers: an article printed as pp. 1360–1380 reports pages 1–21.

### Retrieve

- `expand` — a longer slice of text around a search hit's `charOffset`.
- `fulltext` — the whole item as markdown; `--clean` drops duplicate blocks and boilerplate such as citation notices and table-of-contents lines.
- `blocks` — the item's paragraphs, headings, and list items, paginated, with section paths and page hints.

These three and `search-in` take `--key` as either an `itemKey` or a citation key; a leading `@` is stripped, so Pandoc citations paste straight in. Output always identifies items by `itemKey`. An item with several indexed attachments reads as one document.

`search`, `search-in`, `expand`, `fulltext`, and `blocks` read the local index, so run `sync` after the library changes; a newly added item is not searchable until then.

### Add and discover

- `add` creates a Zotero item from a DOI, a Semantic Scholar paper, a web page or identifier ([via translation-server](#adding-from-a-web-page-or-identifier)), [JSON](#adding-from-json), or manual fields, and returns its `itemKey`. It does not check for duplicates. New items are tagged `Added by Zotagent`, and [`--attach-file`](#attaching-a-local-file) links a local file to the new item.
- `s2` searches Semantic Scholar; pass a returned `paperId` to `add --s2-paper-id`. A paper with a DOI is imported from the DOI record, with Semantic Scholar filling only the gaps (usually the abstract); without a DOI, or when the DOI import fails, Semantic Scholar's own metadata is used.
- `s2-refs` / `s2-citations` list the papers a work cites and the papers that cite it.
- `recent` lists the items most recently added or modified, straight from the Zotero Web API.

## Installation

```bash
brew install TomBener/tap/zotagent   # the CLI; pulls in Node.js and OpenJDK
npx skills add TomBener/zotagent     # the zotagent skill for your agent
```

The `pdftotext` fallback needs Poppler (`brew install poppler`).

## Configuration

Run `zotagent config` for an interactive wizard, or edit `~/.zotagent/config.json`:

```json
{
  "bibliographyJsonPath": "~/Zotero/bibliography.json",
  "attachmentsRoot": "~/Zotero/storage",
  "dataDir": "~/Zotagent",
  "semanticScholarApiKey": "<semantic-scholar-key>",
  "zoteroLibraryId": "<library-id>",
  "zoteroLibraryType": "user",
  "zoteroCollectionKey": "<optional-collection-key>",
  "zoteroApiKey": "<zotero-api-key>",
  "translationServerUrl": "http://127.0.0.1:1969"
}
```

| Field | Used by | Where to get it |
|---|---|---|
| `bibliographyJsonPath` | `sync`, `metadata` | A Better CSL JSON export from [Better BibTeX for Zotero](https://retorque.re/zotero-better-bibtex). See the note below before your first export. |
| `attachmentsRoot` | `sync`, `--attach-file` | The folder holding your attachment files: Zotero → Settings → Files and Folders → "Linked Attachment Base Directory" for linked files, usually `~/Zotero/storage` for stored ones. |
| `dataDir` | everything that reads the index | Any folder. Put it in iCloud or Dropbox to [share the index across machines](#sharing-the-index-across-machines). |
| `zoteroLibraryId`, `zoteroLibraryType` | Zotero Web API calls | Your userID heads the "Applications" section of [zotero.org/settings/security](https://www.zotero.org/settings/security); use `"user"`. For a group library, use `"group"` and the group ID. |
| `zoteroApiKey` | `add`, `recent`, `--tag`, `--collection-key`, the sync tags | [zotero.org/settings/keys/new](https://www.zotero.org/settings/keys/new). Read access is enough except for `add`, which needs write access. Without a key, sync ignores the tags. |
| `zoteroCollectionKey` | `add` (optional) | The collection new items go into: the last segment of `zotero.org/<user>/collections/<key>`. |
| `semanticScholarApiKey` | `s2`, `s2-refs`, `s2-citations`, `add --s2-paper-id` | The "API Key Form" on [semanticscholar.org/product/api](https://www.semanticscholar.org/product/api#api-key); approval takes a few business days. |
| `translationServerUrl` | `add --from-url`, `add --identifier` (optional) | See [below](#adding-from-a-web-page-or-identifier). |
| `excludeTag`, `verticalTextTag` | `sync` (optional) | Rename the sync tags (defaults `zotagent:exclude`, `zotagent:vertical`). |

Any field can also come from an environment variable such as `ZOTAGENT_DATA_DIR` or `ZOTAGENT_ZOTERO_API_KEY`; the Zotero and Semantic Scholar fields also accept unprefixed names like `ZOTERO_API_KEY`.

> [!IMPORTANT]
> **Better CSL JSON omits `zotero-item-key` by default, and zotagent silently skips any item without it.** Add this postscript at Edit → Preferences → Better BibTeX → Export → Postscript, and set the auto-export trigger to `On Change` so `bibliography.json` follows the library:
>
> ```javascript
> if (Translator.BetterCSLJSON) {
>   csl["zotero-item-key"] = zotero.key;
> }
> ```

### Sharing the index across machines

Point `dataDir` on every machine at the same synced folder, run `sync` only on the machine that holds all the attachment files, and set `"syncEnabled": false` on the others (or `ZOTAGENT_SYNC_ENABLED=false`). There, `sync` stops with `SYNC_DISABLED` before touching anything; without the guard, a stray `sync` would see every attachment as missing and wipe the shared index. A value that cannot be read as true or false also disables sync. Lookups (`search`, `search-in`, `metadata`, `blocks`, `expand`, `fulltext`) keep working, and keyword `search` and `search-in` leave the keyword index as it is: a missing or empty one fails with `INDEX_EMPTY` instead of being rebuilt there.

`search --semantic` also needs the same embedding model file on every machine. QMD caches it under `~/.cache/qmd/models/`, and a machine holding a different revision fails with `SEMANTIC_INDEX_MISMATCH` rather than returning random results. Copy the file from the syncing machine and compare with `shasum -a 256`.

## Usage

`zotagent help` lists every command and flag. Success prints `{ok: true, data, meta?}`; failure prints `{ok: false, error: {code, message, details?}}` and exits 1.

```bash
zotagent sync
zotagent search '"party secretary" NEAR/20 governance'
zotagent search-in "Acemoglu" --key CMJ3N8TL
zotagent expand --key KG326EEI --offset 18432 --radius 1500
zotagent metadata --author "Pratt" --year 1985
zotagent add --doi "10.1111/dech.70058"
```

## Adding items

### Adding from a web page or identifier

`add --from-url` and `add --identifier` run Zotero's own [translators](https://github.com/zotero/translators), the site extractors behind the browser connector's save button, through a [translation-server](https://github.com/zotero/translation-server). Their output carries the full Zotero field set, editors and translators as creators, publisher keywords as tags, and translator notes as child notes.

```bash
docker run -d -p 1969:1969 --name translation-server zotero/translation-server
# then set "translationServerUrl": "http://127.0.0.1:1969"

zotagent add --from-url "https://www.nature.com/articles/s41586-020-2649-2"
zotagent add --identifier 9780691237558      # DOI, ISBN, PMID, or arXiv ID
zotagent add --doi "10.1111/dech.70058"      # also goes through the server once it is configured
```

- A page that lists several items (search results, a table of contents) fails with `MULTIPLE_RESULTS` and a `details.choices` list of `{key, title}`; re-run with `--select <key>` to import one.
- Manual flags (`--title`, `--author`, `--collection-key`, `--attach-file`, …) override the translated fields. `AddResult.noteItemKeys` lists the child notes created.
- The server fetches raw HTML with no browser session and no JavaScript, so paywalled or script-heavy pages may translate poorly or not at all; identifier lookups are unaffected. For CNKI, use `add --json`.
- Attachments are never saved, because translation-server strips them. Download the file and pass `--attach-file`.
- Without `translationServerUrl`, `--doi` uses doi.org's CSL JSON.

### Adding from JSON

`add --json` takes metadata you already have, for example from a CNKI page whose DOI doesn't resolve through CrossRef. Pass a file holding one object or an array, or `-` to read stdin:

```bash
zotagent add --json papers.json --collection-key COLL1234
your-extractor | zotagent add --json -
```

`--collection-key` is the only flag allowed with `--json`, and it overrides every item's `collections`. `data` is always an array, one entry per input item. A failed item appears in place as `{ok: false, error: {code, message}, title?, itemType?}` and the rest of the batch still runs; the command as a whole fails only on unparseable input, missing config, or an empty input. Successful entries are regular `AddResult`s (`source: "json"`), and their optional `warnings` and `attachmentItemKey` are left out when there is nothing to report, so read them as `result.warnings?.length ?? 0`.

Only `title` is required. Any other Zotero field (`volume`, `issue`, `pages`, `ISSN`, `ISBN`, `publisher`, `place`, `series`, `university` for a thesis, `language`, `extra`, `url`, …) passes through under its own name and is dropped silently when the item type lacks it. The aliases:

| Input field | Maps to | Notes |
|---|---|---|
| `itemType` | `itemType` | Defaults to `journalArticle`. An unknown type fails that item with `INVALID_ITEM_TYPE`; an outage, timeout, or rate limit during the check is `JSON_ITEM_FAILED`. |
| `creators` | `creators` | Zotero shape: `{creatorType, firstName?, lastName?, name?}`. Wins over `authors`, with a warning. |
| `authors` | `creators` | Strings. `"Last, First"` and `"First Last"` are split; a single token such as `"李华"` stays one name. |
| `tags` | `tags` | `{tag}` objects or plain strings. Wins over `keywords`, with a warning. |
| `keywords` | `tags` | Strings. |
| `abstractNote` / `abstract` | `abstractNote` | First non-empty wins. |
| `DOI` / `doi` | `DOI` | Cleaned like `--doi`. An invalid DOI is dropped with a warning; the item is still created. |
| `publicationTitle` / `publication` / `journal` | container field | Lands in `bookTitle`, `proceedingsTitle`, `websiteTitle`, … as the item type requires. |
| `date` / `year` | `date` | First non-empty wins; a number is accepted. Zotero has no `year` field. |
| `accessDate` / `access-date` / `accessedAt` | `accessDate` | First non-empty wins. |
| `collections` / `collectionKey` | `collections` | A key or an array of keys; an item can land in several collections. Falls back to `zoteroCollectionKey` when neither this nor `--collection-key` is set. |
| `attachFile` / `attach-file` | linked-file child | See [Attaching a local file](#attaching-a-local-file). A bad path fails the item with `INVALID_ATTACH_FILE` before the parent is created. |

### Attaching a local file

```bash
zotagent add --title "Paper" --author "Doe, Jane" --attach-file ~/Downloads/foo.pdf
```

The file is linked, not uploaded: Zotero stores only its path (`linkMode: "linked_file"`), so your storage quota is untouched, and `AddResult.attachmentItemKey` names the new attachment. Set Zotero's Linked Attachment Base Directory to the same folder as `attachmentsRoot`, and a file under it is stored as `attachments:<rel>`, which follows the library to other machines; a file elsewhere is stored by absolute path. A bad path fails before the parent item is created. If the parent is created but the attachment fails, you still get the parent's `itemKey`, with a warning. With `--json`, set `attachFile` on each item instead.

The content type comes from the extension (`pdf`, `epub`, `html`/`htm`, `txt`); anything else is sent as `application/octet-stream`.

## Development

```bash
npm install
npm run check       # tsc --noEmit, then the test suite (tsx --test)
npm run build       # tsc → dist/
npm run dev -- sync # run the CLI from source via tsx
```

## License

MIT. See [LICENSE](./LICENSE).
