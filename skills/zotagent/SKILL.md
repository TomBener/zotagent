---
name: zotagent
description: Search, quote from, add to, and edit the user's Zotero library through the `zotagent` CLI. Use it to find papers or passages (keyword, semantic, or metadata search), pull quotations and context from indexed papers, add items (DOI, web page URL, ISBN / PMID / arXiv identifier, Semantic Scholar paperId, JSON, or manual metadata), edit existing items (fix a field, add or remove tags, file into a collection, attach a note, trash an item), follow a paper's references and citations, inspect recent Zotero items, or diagnose indexed attachments. Use it on indirect requests too — any mention of references, citations, bibliography checks, PDF passages, or literature discovery. Read it before running any zotagent command.
---

# zotagent

Task commands emit JSON: `{ok: true, data, meta?}` on success, `{ok: false, error, meta?}` + exit 1 on failure. If you need a command or flag not covered here, run `zotagent help`.

Give the user only keys and quotes taken from tool output. If a query returns nothing, say so.

## Three search layers — pick the right one

| Command | Searches over | Good for |
|---|---|---|
| `zotagent search "<q>" [--semantic] [--tag <tag>] [--collection-key <key>] [--limit n] [--min-score n]` | Indexed full text of PDF / EPUB / HTML / TXT attachments only — body, not title (FTS5 keyword by default; qmd vector search with `--semantic`) | Finding passages that discuss a topic across the library or within a tagged or collection-scoped subset |
| `zotagent search-in "<q>" --key <k> [--limit n]` | Full text of one item's indexed attachments | Drilling into a single paper for terms or quoted phrases |
| `zotagent metadata ["<q>"] [metadata filters...] [--tag <tag>] [--collection-key <key>] [--field f] [--abstract] [--indexed] [--limit n]` | Bibliography fields: title / author / year / journal / publisher / abstract | Finding papers by metadata or by title, verifying existence, resolving an `itemKey` |

### Keyword syntax

`search` and `search-in` both run SQLite FTS5 with a porter stemmer over a Trad→Simp folded index, and both evaluate most queries against per-block FTS:

| Operator | Example | Notes |
|---|---|---|
| Exact phrase | `"institutional change"` | Token-adjacent match. Quotes a multi-word phrase. A word with punctuation inside (`COVID-19`, `U.S.`, `Olson's`) is matched as a phrase without quotes. |
| AND (default) | `alpha beta` | Implicit between bare tokens. |
| OR | `Acemoglu OR Robinson` | Must be uppercase. Lowercase `or` is a literal term, not an operator. |
| NOT | `alpha NOT beta` | Excludes the right-hand expression. Same uppercase rule. There is no `-beta` form; a `-` before a term (`-beta`, `- beta`, `-(a OR b)`) fails with `INVALID_ARGUMENT`, as does a dangling `AND` / `OR` / `NOT` or a query of punctuation only. |
| Proximity | `"土地" NEAR/20 "开发"` | Within N tokens, unordered. Use `NEAR/<n>`, not bare `NEAR` or `NEAR(...)`. |
| Prefix wildcard | `Pete*` | Matches any token starting with `Pete`: `Peter`, `Petersen`, etc. Wildcard only at the end. |

**`NEAR/<n>` is the best first pass** when you have 2–3 anchor terms that should co-occur but not necessarily adjacent — e.g. `"土地" NEAR/20 "利用"`. It is usually more precise than plain keyword and much faster than `--semantic`, and especially useful on OCR'd or scanned materials (Republican China vertical-layout texts, old gazetteers, etc.), where one keyword often drowns in noise.

Keyword vs semantic heuristic: start with keyword (exact phrases, `OR`, `NEAR`) for names, anchor terms, quotations, or `--tag` / `--collection-key` scoping; switch to `--semantic` when phrasing is fuzzy or you want conceptual neighbors. `--tag`, `--collection-key`, and `--min-score` cannot be combined with `--semantic`, and `--semantic` rejects text with no letters or digits (`INVALID_ARGUMENT`), as keyword search does; a semantic `score` is a rank position (1, 0.5, 0.33, …), not a relevance value, so judge semantic hits by their passages.

Chinese trad/simp folding: keyword `search`, `search-in`, and `metadata` match across 繁 ↔ 简 both ways (汉字 ≡ 漢字), so one form is enough. An unquoted CJK run is an ordered phrase: `会社` matches only 会社, never 社会; separate words with spaces (`国家 能力`) to require both anywhere in a block. Keyword search also folds ligatures and full-width forms (NFKC), so `exemplifies` finds `exempliﬁes` and `1949年` finds `１９４９年`. `search --semantic` does NOT fold because it uses qmd embeddings over the source text. Returned text (`passage`, `blocks`, `fulltext`, `expand`) preserves the original form as stored in the attachment.

### Scoping by tag or collection

`--tag` and `--collection-key` work the same on keyword `search` and on `metadata`. Both require Zotero read API config.

- `--tag "PhD Thesis"` fetches matching top-level item keys from the Zotero Web API, then filters local results — so put workflow tags on the parent item, not the PDF attachment. Repeat `--tag` to AND tags. A tag no top-level item carries returns a warning rather than an error — check its spelling before concluding the library has nothing.
- `--collection-key ABCD1234` filters to top-level items directly in the named Zotero collection (the 8-char key shown at the end of `zotero.org/<user>/collections/<key>`). Repeat `--collection-key` to union across collections; combine with `--tag` for an intersection. Direct members only — sub-collections are not included. An unknown key fails with `COLLECTION_NOT_FOUND`; a collection with no top-level items returns a warning.

### Metadata quick rules

- Positional query, field filters (`--author` / `--year` / `--title` / `--journal` / `--publisher`), or both are valid.
- `--field` scopes only the positional query; filter flags AND together.
- `--abstract` includes abstract text in the output (omitted by default to keep responses compact). To search abstract text, use a positional query with `--field abstract`.
- Each result reports `indexed` / `indexedFiles`, read from the shared full-text index: whether `search-in` / `fulltext` can read the item. This is device-independent — it says nothing about whether attachment files exist on the current machine, and a `file` entry in Zotero alone does not make it true; the attachment must have been extracted by a `sync`. A scan with no text layer stays `indexed: false` even after a sync: extraction records it as an error until the PDF is OCR'd. `--indexed` keeps only indexed items.
- `metadata "Pratt 1985"` generally returns empty (year is not OR'd in) — split into `--author "Pratt" --year "1985"`.
- A CJK author matches written together or spaced: `--author 余泳泽` and `--author "余 泳泽"` both find family 余 + given 泳泽.

## Reading results

- **`search` returns one row per matched item** — an item with several indexed attachments appears once, through its best-ranking block (by FTS5 bm25) across all of them. A `search` result means *this document* matches and here is one representative passage. `search --limit` defaults to 10 and is capped at 100 (a larger value fails with `INVALID_ARGUMENT`); narrow the query or scope it with `--tag` / `--collection-key` rather than paging deeper. `search --semantic` draws on a fixed pool of about 40 candidate documents, so it can return fewer rows than `--limit` even when more of the library is relevant.
- **`search-in` returns scoped matches.** Most rows are single-block FTS matches, up to `--limit`; a single quoted phrase can also span blocks via the manifest-level exact scanner. When the user asks "does this paper say X" or "where in this paper does Y appear", reach for `search-in`. Its default `--limit` of 10 is usually enough — you're already scoped to one document. Increase it to inspect more lower-ranked matches; change the query when the returned blocks do not match the user's intent.
- **`search-in` on a chapter key may miss.** `SEARCH_IN_FAILED: No indexed attachment found` usually means the chapter's PDF is indexed only inside its parent volume. Look the parent up with `metadata`, then `search-in` against the parent's key and locate the chapter by its heading. Common for edited collections and proceedings.
- **`passage` is a compact character window centered on the hit**, capped at ~500 tokens. A leading/trailing `…` means there is more text outside the returned slice or the token cap was hit; `expand --key <k> --offset <charOffset>` fetches more — `--radius` is the half-window in characters (default 1000); raise it for a longer slice.
- **`charOffset` is item-global, not per-attachment.** When an item has multiple indexed attachments, offsets run monotonically across them with `# Attachment: <name>` dividers in the merged markdown. Feed `charOffset` from any search result straight into `expand`.
- **`--key` accepts `itemKey` or `citationKey`**, with or without a leading `@` (so Pandoc `@citekey` pastes straight in). Output always identifies items by `itemKey` only — `citationKey` is accepted as input but never emitted, so chain subsequent calls on `itemKey`.

## Citing passages

Paraphrase by default and cite in **Pandoc source form** using the returned `itemKey`. Reach for a verbatim quote only when the exact wording matters (a distinctive phrase, primary-source quotation, or a definition) — quoting indiscriminately turns the document into a transcript. Before quoting, fetch a clean slice with `expand` if the passage looks truncated or garbled (OCR noise, mid-word cuts).

Do not put `pageStart` / `pageEnd` in a citation. They are positions in the PDF file, counted from 1, not the page numbers printed in the paper or book: a journal article printed as pp. 1360–1380 comes back as pages 1–21, and a book's front matter shifts every page (printed p. 96 can come back as `pageStart: 98`).

- Paraphrase: `[@itemKey]`
- Verbatim phrase when wording is load-bearing: `... a "non-trivial role" [@itemKey]`
- Narrative reference: `@itemKey says ...`

Do not cite `charOffset` or block indices in user-facing prose. `charOffset` is what you pass to `expand` to fetch more context; block indices appear in `blocks` output but no PDF/EPUB reader navigates by them.

## Typical workflows

### Find passages, then retrieve surrounding context

```bash
# Library-wide search — keyword by default; --semantic for fuzzy/conceptual queries
zotagent search "party secretary governance"
zotagent search "informal political networks in contemporary China" --semantic --limit 20
zotagent search "local fiscal capacity" --tag "PhD Thesis"
zotagent search "land reform" --collection-key ABCD1234 --tag "PhD Thesis"

# Drill into one paper. A bare surname catches both in-text "Acemoglu and
# Robinson 2012" and bibliography "Acemoglu, Daron. 2012".
zotagent search-in 'Acemoglu' --key CMJ3N8TL

# Expand around a returned hit, or read the whole item
zotagent expand --key KG326EEI --offset 18432 --radius 1500
zotagent fulltext --key KG326EEI --clean
zotagent blocks --key KG326EEI --limit-blocks 40    # paginated structured view; rarely needed
```

### Look up a paper's metadata

```bash
# Search selected fields with a positional query
zotagent metadata "aging in China" --field title --field abstract

# Use a year prefix for a range; `--year 198` matches the 1980s
zotagent metadata --author "Pratt" --year "198"

# Combine a positional query with a filter
zotagent metadata "imperial" --author "Pratt"

# List a tag or a collection, or intersect them with a query
zotagent metadata --tag "PhD Thesis"
zotagent metadata "land reform" --collection-key ABCD1234 --tag "PhD Thesis"

# Keep only indexed items; include abstract text only when needed
zotagent metadata "dangwei shuji" --indexed
zotagent metadata "aging in China" --abstract
```

### Add a paper to Zotero

Source priority when adding: a DOI → `--doi` (a bare DOI, `doi:10.…`, or a doi.org link; an arXiv ID works as `--doi 10.48550/arXiv.<id>`; a PMID resolves to a DOI on PubMed); CNKI or other pre-extracted metadata → `--json`; a web page → find the DOI on the page (citation block, meta tags) and use `--doi`, otherwise extract the metadata yourself into `--json` or manual fields; an ISBN → Open Library / Google Books metadata into `--json` or manual fields with `--item-type book`; a paper with no DOI at all → `s2` search, then `add --s2-paper-id` (its rate limit is under Semantic Scholar below).

```bash
# Add by DOI (arXiv IDs have a DOI form)
zotagent add --doi "10.1111/dech.70058"
zotagent add --doi "10.48550/arXiv.2406.01234"

# Search Semantic Scholar, then add by paperId
zotagent s2 "state-owned enterprise governance" --limit 5
zotagent add --s2-paper-id <paperId>

# --s2-paper-id also takes a DOI, an arXiv id, or a prefixed identifier
zotagent add --s2-paper-id "10.1093/ajae/aaq063"
zotagent add --s2-paper-id "ARXIV:2106.15928"

# Manual fallback — authors go in Zotero "Last, First" form; repeat --author for multiple
zotagent add --title "Title of a paper" --author "Zhang, San" --year 2026 --publication "Journal of Important Studies"

# Add a book — pass --item-type, otherwise manual adds default to journalArticle
# (URL-only manual adds become webpage)
zotagent add --title "Fifty Years of Land Reform" --author "Hsiao, Cheng" --year 1980 --publication "China Land Policy Institute" --item-type book

# Add from pre-shaped JSON (best for CNKI)
zotagent add --json paper.json
zotagent add --json batch.json --collection-key COLL1234
your-extractor | zotagent add --json -

# Attach a local PDF; in --json mode, each item carries its own attachFile / attach-file field
zotagent add --title "Paper" --author "Doe, Jane" --attach-file ~/Downloads/foo.pdf
echo '{"itemType":"journalArticle","title":"...","attachFile":"/path/to/foo.pdf"}' | zotagent add --json -
```

Manual flags given alongside `--doi` (`--title`, `--author`, `--year`, `--publication`, `--item-type`) override the DOI record's fields, and `--title` doubles as a fallback: if the DOI lookup fails, or Zotero refuses the DOI record, the item is created from the manual fields and `data.warnings` says so. Without `--title` a failed DOI lookup fails the command.

`add --json` input fields — only `title` is required: `itemType` (default `journalArticle`); `authors` as strings (`"Last, First"` or `"First Last"`; a single token such as `"李华"` stays one name) or Zotero-shaped `creators`; `date` or `year` (a number is fine); `publicationTitle` / `publication` / `journal` (routed to `bookTitle`, `proceedingsTitle`, … by item type); `abstract`; `doi`; `keywords` or `tags` as strings; `url`; `accessDate`; `collections` (a key or an array of keys); `attachFile`. Any other Zotero field name (`volume`, `issue`, `pages`, `publisher`, `place`, `ISBN`, `language`, `extra`, …) passes through, and is dropped silently when that item type has no such field.

`add --json` always returns `data` as an array, even for one input object. Per-item failures are returned in-place as `{ok: false, error: ...}` and do not abort the rest of a batch; parse/config/empty-input failures fail the whole envelope. Per-item codes: `INVALID_ITEM_TYPE` — Zotero does not know that `itemType`; fix the type and resend only that item. `INVALID_ATTACH_FILE` — the item's attach path is bad (see below). `JSON_ITEM_FAILED` — anything else (network, timeout, rate limit, a Zotero error); the message says which, and a transient cause is worth one later retry of that item.

`--attach-file` creates a `linkMode=linked_file` child: the file stays on disk and uses no Zotero storage quota. When the path is under `attachmentsRoot`, zotagent stores it as `attachments:<rel>` for cross-device portability. `AddResult.attachmentItemKey` is set when an attachment was created. A bad `--attach-file` path fails *before* the parent item is written, so it cannot leave an orphan citation in Zotero (per-item failure code: `INVALID_ATTACH_FILE`). If the parent item creates but the attachment POST fails, the parent itemKey is still returned and the failure is surfaced as a warning. Other `add` flags not shown above: `--url`, `--url-date` (alias `--access-date`).

`add --from-url` / `add --identifier` exist but assume a self-hosted Zotero translation server, which is normally not configured — expect `TRANSLATION_SERVER_NOT_CONFIGURED` and reroute by the source priority above instead of retrying. Set `translationServerUrl` only while a server is actually running (configured-but-dead fails `--doi` too).

### Semantic Scholar: search, references, and citations

**S2 rate limit**: 1 request/second, cumulative across Semantic Scholar endpoints (`s2`, `s2-refs`, `s2-citations`, `add --s2-paper-id`). Run these sequentially, never in parallel — parallel calls will 429. zotagent retries a 429 on its own (up to 2 retries, honoring `Retry-After`, each wait capped at 10s), so an occasional collision is absorbed; if the retries run out the command fails with `RATE_LIMITED` and the fix is to slow down, not to retry harder. Spacing between separate tool calls is usually enough; no sleep needed. All four commands need `semanticScholarApiKey` in the config; without it they fail with `SEMANTIC_SCHOLAR_NOT_CONFIGURED` — a config problem, never worth retrying. An identifier Semantic Scholar does not know fails with `PAPER_NOT_FOUND`: check the identifier, or find the paper by title with `s2 "<title>"` and pass the returned `paperId` — retrying the same id will not help.

`s2` results include `openAccessPdfUrl` when available — surface it to the user as a free PDF link alongside the `add` suggestion.

Citation chaining is the strongest discovery signal in a literature review: `s2-refs` returns the papers a work cites (its bibliography, i.e. backward in time), `s2-citations` the papers that cite it (forward in time).

```bash
# Backward: what does this paper build on?
zotagent s2-refs "10.18653/v1/N18-1022" --limit 20

# Forward: who has cited it since?
zotagent s2-citations "DOI:10.18653/v1/N18-1022" --limit 20

# Page through a long bibliography — data.next is the offset for the next call
zotagent s2-refs 649def34f8be52c8b66281af98ae884c09aef38b --limit 50 --offset 50

# Quote URLs so the shell does not eat the ? and &
zotagent s2-refs "https://arxiv.org/abs/2106.15928" --limit 10
```

Both take **one identifier, never a title**: a 40-character `paperId`, a DOI, an arXiv id, a prefixed id (`DOI:`, `ARXIV:`, `PMID:`, `CorpusId:`, `URL:`), or a doi.org / arxiv.org / semanticscholar.org URL. For a paper you only know by title, run `s2 "<title>"` first and pass a returned `paperId`. A bad identifier fails locally with `INVALID_ARGUMENT` and spends no request.

Rows carry `isInfluential: true` when Semantic Scholar marks the edge influential — a useful ranking hint on a long bibliography. Rows deliberately **omit the abstract**; to read one, feed that row's `paperId` to `add --s2-paper-id` (which fetches the full record) or look the paper up in the library with `metadata`. Entries Semantic Scholar has no record for are dropped and reported in `data.warnings`.

An empty `results` with `ok: true` is a real answer, not a failure: some publishers withhold reference lists from Semantic Scholar, so `s2-refs` on such a paper returns nothing while `s2-citations` on it still works. Don't retry it — try the other direction, or a different identifier for the same work.

### List recently added or modified items

```bash
# Most recent 10 additions (default)
zotagent recent

# Top 20 most recently modified items
zotagent recent --limit 20 --sort modified
```

`recent` hits the Zotero Web API directly (no index required), so items just created with `add` show up immediately — useful for confirming an `add` landed, or for orienting yourself in the library. Returns regular top-level bibliography items only; standalone notes and attachments are skipped.

### Check or repair the local index

**Never run `sync` unprompted — only when the user explicitly asks for it.** The device you are running on may not hold the complete attachment set (e.g. PDFs in `attachmentsRoot` still cloud placeholders or mid-download): a sync from an incomplete copy rewrites the shared index/data files and can corrupt them as they replicate to other devices. A stale index is the user's call to refresh, not yours.

```bash
# Counts, paths, and qmd status
zotagent status

# Rebuild / refresh local full-text indexes
zotagent sync

# Retry unchanged files that previously failed extraction
zotagent sync --retry-errors

# Tune heavy PDF extraction on large libraries
zotagent sync --pdf-concurrency 1 --pdf-batch-size 4 --pdf-timeout-ms 900000

# Surface suspicious extraction output before quoting heavily from a corpus
zotagent diagnose --limit 20
```

Sync exclusions are driven by a Zotero tag, not a local file: tag a top-level item `zotagent:exclude` in Zotero and the next `sync` skips it entirely (no extraction, no indexing) and removes it from the local indexes. The tag name can be changed via `excludeTag` in `~/.zotagent/config.json` or the `ZOTAGENT_EXCLUDE_TAG` environment variable; resolving tagged items requires the Zotero read API config (`zoteroLibraryId` + `zoteroApiKey`). Use `diagnose` to find candidates such as OCR-failed scans, vertical-CJK PDFs, or multi-column gazetteers, then tag or re-OCR them before re-syncing.

Three sync refusals stop before anything is touched; report them to the user rather than working around them. `SYNC_DISABLED`: this host is configured read-only (`syncEnabled: false`) because it shares an index another machine maintains, or its setting holds a value that cannot be read (the message names it) — never flip the setting to get past it. `ZOTERO_TAG_LOOKUP_FAILED`: the configured Zotero API could not list the tagged items and no earlier lookup saved a list to fall back on (after one successful lookup, sync runs offline on the saved list) — retry once the API is reachable; never remove the Zotero credentials to get past it, since that re-extracts every vertical-text PDF with the wrong reading order. `MASS_REMOVAL_REFUSED`: the bibliography resolved no attachments, or dropped more than 10% (and at least 50) of the indexed items — usually a truncated bibliography export or a wrong `attachmentsRoot`; the message says how to proceed if the removal is intended.

## Index freshness

`search` / `search-in` / `blocks` / `expand` / `fulltext` read a local index. Several of the errors and warnings below tell you to run `zotagent sync`: relay that advice to the user and leave the run to them (the `sync` rule above). Pass these on to the user:

- `INDEX_EMPTY` means the index holds no documents. The message says whether to run `sync` or to copy the index from the host that syncs.
- A `search` / `search-in` warning that the keyword index "was built by a different zotagent version": a `sync` rebuilds it, or on a host with sync disabled, matching zotagent versions across hosts (results can miss matches until then).
- `SEMANTIC_INDEX_MISMATCH` from `--semantic` means this host's embedding model computes different vectors than the ones in the index, so semantic results would be random: tell the user (the message says which host to fix) and fall back to keyword search.

With `--tag` / `--collection-key`, a warning that matched items "have no searchable text here" gives the reason for each group: excluded by tag, failed extraction, missing file, unsupported type, or not in the local index. Only the last group is a sync away. `metadata` / `add` / `s2` / `s2-refs` / `s2-citations` / `recent` work without the local index (`metadata` then reports `indexed: false` everywhere and warns that the index catalog is empty). After `add`, the new paper isn't full-text searchable until the next `sync`.

## Editing Zotero, and fields the CLI doesn't return

`zotagent` reads a local index plus a local bibliography export, and its only write is creating items with `add`. Go to the Zotero API directly for one item's complete field set (DOI, volume, pages, URL, tags, collections, dates), for collection keys and the tag list, and for every edit — changing a field, adding or removing a tag, filing into a collection, attaching a note, trashing an item. Read [`references/zotero-web-api.md`](references/zotero-web-api.md) before the first such call: it carries the credential handling, the read-modify-write rule that keeps an edit from wiping the fields you didn't send, and the confirmation gate on deletions.
