---
name: zotagent
description: Search, retrieve, or add Zotero literature via the `zotagent` CLI. Load this skill whenever the user wants to query their Zotero library (keyword / semantic / metadata), pull quotations or context from indexed papers, add new items by DOI or Semantic Scholar paperId, or resolve bibliographic metadata. Use it even when the request is indirect — any mention of references, citations, bibliography checks, PDF passages, or literature discovery should trigger this skill. Do not guess at zotagent's flags — consult this reference first.
---

# zotagent

`zotagent` is a CLI for a Zotero library: search and retrieve indexed attachments (PDF / EPUB / HTML / TXT) and bibliography metadata, and add items by DOI, Semantic Scholar paperId, or manual fields. Commands are stateless; every output is JSON (`{ok, data}` on success, `{ok: false, error}` + exit 1 on failure).

Don't invent citation keys, item keys, or passage text. If a query returns nothing, say so.

## Three search layers — pick the right one

| Command | Searches over | Good for |
|---|---|---|
| `zotagent search "<q>" [--semantic] [--limit n] [--min-score n]` | Indexed full text only — body, not title (FTS5 keyword by default; vector + LLM query expansion with `--semantic`) | Finding passages that discuss a topic across the library |
| `zotagent search-in "<q>" --key <k> [--limit n]` | Full text of one item's attachments | Drilling into a single paper for a term |
| `zotagent metadata ["<q>"] [metadata filters...] [--field f] [--abstract] [--has-file] [--limit n]` | Bibliography fields: title / author / year / journal / publisher / abstract | Finding papers by metadata or by title, verifying existence, resolving an `itemKey` |

**Title queries belong in `metadata`, not `search`.** `search` only matches body text; a query like `search "Attention Is All You Need"` will find passages that mention the phrase, not the paper with that title. Use `metadata "Attention Is All You Need" --field title` for title-driven lookups.

Metadata quick rules:
- Positional query, field filters (`--author` / `--year` / `--title` / `--journal` / `--publisher`), or both are valid.
- `--field` scopes only the positional query; filter flags AND together.
- `--abstract` includes abstract text in the output. To search abstract text, use a positional query with `--field abstract`.
- `metadata "Pratt 1985"` generally returns empty (year is not OR'd in) — split into `--author "Pratt" --year "1985"`.

Keyword syntax — `search` and `search-in` both run SQLite FTS5 with a porter stemmer over a Trad→Simp folded index:

| Operator | Example | Notes |
|---|---|---|
| Exact phrase | `"institutional change"` | Token-adjacent match. Quotes a multi-word phrase. |
| AND (default) | `alpha beta` | Implicit between bare tokens. |
| OR | `Acemoglu OR Robinson` | Must be uppercase. Lowercase `or` is a literal term, not an operator. |
| NOT | `alpha NOT beta` | Excludes the right-hand expression. Same uppercase rule. |
| Proximity | `"土地" NEAR/20 "开发"` | Within N tokens, unordered. Use `NEAR/<n>`, not `NEAR`. |
| Prefix wildcard | `Pete*` | Matches any token starting with `Pete`: `Peter`, `Petersen`, etc. Wildcard only at the end. |

Both `search` and `search-in` evaluate the query against per-block FTS. `search-in` returns every matching block in the targeted document; `search` returns one row per matched document — each doc's best-ranking block (by FTS5 bm25) is the surfaced passage.

**`NEAR/<n>` is the best first pass** when you have 2–3 anchor terms that should co-occur but not necessarily adjacent — e.g. `"土地" NEAR/20 "利用"`. It is usually more precise than plain keyword and much faster than `--semantic`.

Keyword vs semantic heuristic: start with keyword (exact phrases, `OR`, `NEAR`) for names, anchor terms, or quotations; switch to `--semantic` when phrasing is fuzzy or you want conceptual neighbors. `NEAR/<n>` is especially useful on OCR'd or scanned materials (Republican China vertical-layout texts, old gazetteers, etc.), where one keyword often drowns in noise.

Chinese trad/simp folding: keyword `search`, `search-in`, and `metadata` match across 繁 ↔ 简 both ways (黨組書記 ≡ 党组书记), so one form is enough. `search --semantic` does NOT fold — pick the likely source form.

## Citing passages

Paraphrase by default and cite in **Pandoc source form** using the returned `itemKey` with `pageStart` / `pageEnd` as the locator. Reach for a verbatim quote only when the exact wording matters (a distinctive phrase, primary-source quotation, or a definition) — quoting indiscriminately turns the document into a transcript.

- Paraphrase + locator: `[@itemKey, p. 23]`
- Page range: `[@itemKey, pp. 23–25]`
- No page available: `[@itemKey]` (EPUB and some scans never set page numbers)
- Verbatim phrase when wording is load-bearing: `... a "non-trivial role" [@itemKey, p. 137]`
- Narrative reference: `@itemKey says ...`

Page numbers come from PDF extraction and may drift by 1–2 pages on scanned books with unnumbered front matter. If the cited page doesn't contain the quoted concept, scan adjacent pages.

Do not cite `charOffset` or block indices in user-facing prose. `charOffset` is what you pass to `expand` to fetch more context; block indices appear in `blocks` output but no PDF/EPUB reader navigates by them.

Don't invent quotes. If the returned `passage` looks truncated (`…` markers) or garbled (OCR noise, mid-word cuts), call `expand` to fetch a clean slice before quoting.

## Typical workflows

### Find passages, then retrieve surrounding context

```bash
# Library-wide search — keyword by default; --semantic for fuzzy/conceptual queries
zotagent search "party secretary governance"
zotagent search "informal political networks in contemporary China" --semantic --limit 20

# Drill into one paper. A bare surname catches both in-text "Acemoglu and
# Robinson 2012" and bibliography "Acemoglu, Daron. 2012".
zotagent search-in 'Acemoglu' --key CMJ3N8TL

# Expand around a returned hit. `--offset` is the `charOffset` from a search
# result; `--radius` is the half-window in characters (default 1000). Increase
# the radius when the search passage looks truncated or you need more context.
zotagent expand --key KG326EEI --offset 18432 --radius 1500
zotagent fulltext --key KG326EEI --clean
```

### Look up a paper's metadata

```bash
# Search selected fields with a positional query
zotagent metadata "aging in China" --field title --field abstract

# Narrow by specific metadata fields
zotagent metadata --author "Pratt" --year "1985"

# Use a year prefix for a range; `--year 198` matches the 1980s
zotagent metadata --author "Pratt" --year "198"

# Combine a positional query with a filter
zotagent metadata "imperial" --author "Pratt"

# Keep only indexed items; include abstract text only when needed
zotagent metadata "dangwei shuji" --has-file
zotagent metadata "aging in China" --abstract

# Use a returned key with retrieval commands
zotagent fulltext --key KG326EEI --clean
zotagent blocks --key KG326EEI --limit-blocks 40    # paginated structured view; rarely needed
```

### Add a paper to Zotero

```bash
# Add by DOI
zotagent add --doi "10.1111/dech.70058"

# Search Semantic Scholar, then add by paperId
zotagent s2 "state-owned enterprise governance" --limit 5
zotagent add --s2-paper-id <paperId>

# Manual fallback — authors go in Zotero "Last, First" form; repeat --author for multiple
zotagent add --title "Title of a paper" --author "Zhang, San" --year 2026 --publication "Journal of Important Studies"

# Add a book — pass --item-type, otherwise manual adds default to journalArticle
zotagent add --title "Fifty Years of Land Reform" --author "Hsiao, Cheng" --year 1980 --publication "China Land Policy Institute" --item-type book

# Add from pre-shaped JSON (best for CNKI)
zotagent add --json paper.json
zotagent add --json batch.json --collection-key COLL1234
your-extractor | zotagent add --json -

# Attach a local PDF as a linkMode=linked_file child (file stays on disk;
# no Zotero storage quota used). When the path is under attachmentsRoot,
# zotagent stores it as 'attachments:<rel>' for cross-device portability.
zotagent add --title "Paper" --author "Doe, Jane" --attach-file ~/Downloads/foo.pdf
# In --json mode, each item carries its own attachFile / attach-file field.
echo '{"itemType":"journalArticle","title":"...","attachFile":"/path/to/foo.pdf"}' | zotagent add --json -
```

`AddResult.attachmentItemKey` is set when an attachment was created. A bad
`--attach-file` path fails *before* the parent item is written, so it cannot
leave an orphan citation in Zotero (per-item failure code: `INVALID_ATTACH_FILE`).
If the parent item creates but the attachment POST fails, the parent itemKey
is still returned and the failure is surfaced as a warning.

Other `add` flags not shown above: `--url, --url-date` (alias `--access-date`), `--collection-key`.

`s2` results include `openAccessPdfUrl` when available — surface it to the user as a free PDF link alongside the `add` suggestion.

**S2 rate limit**: 1 request/second, cumulative across Semantic Scholar endpoints (`s2` and `add --s2-paper-id`). Run these sequentially, never in parallel — parallel calls will 429. Spacing between separate tool calls is usually enough; no sleep needed.

### List recently added or modified items

```bash
# Most recent 10 additions (default)
zotagent recent

# Top 20 most recently modified items
zotagent recent --limit 20 --sort modified
```

`recent` hits the Zotero Web API directly (no index required), so items just created with `add` show up immediately — useful for confirming an `add` landed, or for orienting yourself in the library. Returns regular top-level bibliography items only; standalone notes and attachments are skipped. Max `--limit` is 100.

## Output-shape gotchas

- **`passage` is a ~500-character window centered on the hit**, capped at ~500 tokens. Trailing `…` means it touches the document boundary or hit the token cap; in either case, call `expand --key <k> --offset <charOffset>` (with a bigger `--radius`) to fetch a longer slice.
- **`charOffset` is item-global, not per-attachment.** When an item has multiple indexed PDFs, offsets run monotonically across them with `# Attachment: <name>` dividers in the merged markdown. Feed `charOffset` from any search result straight into `expand`.
- **`pageStart` / `pageEnd` may be absent** (EPUB, some old scans, multi-attachment items where the hit lives near a separator). Fall back to `[@itemKey]` without a locator in that case.
- **`metadata` omits `abstract` by default** to keep bulk responses compact. Pass `--abstract` when you need it.
- **`--key` accepts `itemKey` or `citationKey`**, with or without a leading `@` (so Pandoc `@citekey` pastes straight in). Output always identifies items by `itemKey` only — `citationKey` is accepted as input but never emitted, so chain subsequent calls on `itemKey`.
- **`search-in` on a chapter key may miss.** `SEARCH_IN_FAILED: No indexed attachment found` usually means the chapter's PDF is indexed only inside its parent volume. Look the parent up with `metadata`, then `search-in` against the parent's key and locate the chapter by its heading. Common for edited collections and proceedings.
- **`search-in` returns block-level matches; `search` returns one passage per item.** A `search-in` row is a single block satisfying the query (operators always evaluate per block); a single quoted phrase that wraps across paragraphs — e.g. a citation breaking mid-line — naturally appears in the windowed passage of one row. A `search` result means *this document* matches and here is one representative passage. When the user asks "does this paper say X" or "where in this paper does Y appear", reach for `search-in`.
- **`search-in --limit` truncates the result list, not the FTS search itself.** Default 10 is usually enough — you're already scoped to one document. Re-running with a bigger limit can never reveal hits the first call missed; change the query, not the limit.

## Index freshness

`search` / `search-in` / `blocks` / `expand` / `fulltext` read a local index. On `NO_INDEX` or "No indexed documents found", suggest `zotagent sync`. `metadata` / `add` / `s2` work without the index. After `add`, the new paper isn't full-text searchable until the next `sync`.

If you need a command or flag not covered here, run `zotagent help`.
