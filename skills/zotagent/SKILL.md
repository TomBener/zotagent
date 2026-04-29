---
name: zotagent
description: Search, retrieve, or add Zotero literature via the `zotagent` CLI. Load this skill whenever the user wants to query their Zotero library (keyword / semantic / metadata), pull quotations or context from indexed papers, add new items by DOI or Semantic Scholar paperId, or resolve bibliographic metadata. Use it even when the request is indirect — any mention of references, citations, bibliography checks, PDF passages, or literature discovery should trigger this skill. Do not guess at zotagent's flags — consult this reference first.
---

# zotagent

`zotagent` is a CLI over a local index of Zotero attachments (PDF / EPUB / HTML / TXT) plus bibliography metadata. Commands are stateless; every output is JSON (`{ok, data}` on success, `{ok: false, error}` + exit 1 on failure).

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

Keyword syntax — `search` and `search-in` both run SQLite FTS5 with a porter stemmer over a Trad→Simp folded index, so the same operators work in both:

| Operator | Example | Notes |
|---|---|---|
| Exact phrase | `"institutional change"` | Token-adjacent match. Quotes a multi-word phrase. |
| AND (default) | `alpha beta` | Implicit between bare tokens. |
| OR | `Acemoglu OR Robinson` | Must be uppercase. Lowercase `or` is a literal term, not an operator. |
| NOT | `alpha NOT beta` | Excludes the right-hand expression. Same uppercase rule. |
| Proximity | `"土地" NEAR/20 "利用"` | Within N tokens, unordered. Use `NEAR/<n>`, not `NEAR`. |
| Prefix wildcard | `Pete*` | Matches any token starting with `Pete`: `Peter`, `Petersen`, etc. Wildcard only at the end. |

Both `search` and `search-in` evaluate the query against per-block FTS. `search-in` returns every matching block in the targeted document; `search` returns one row per matched document — each doc's best-ranking block (by FTS5 bm25) is the surfaced passage.

**`NEAR/<n>` is the best first pass** when you have 2–3 anchor terms that should co-occur but not necessarily adjacent — e.g. `"土地" NEAR/20 "利用"`. It is usually more precise than plain keyword and much faster than `--semantic`.

Keyword vs semantic heuristic: start with keyword (exact phrases, `OR`, `NEAR`) for names, anchor terms, or quotations; switch to `--semantic` when phrasing is fuzzy or you want conceptual neighbors. `NEAR/<n>` is especially useful on OCR'd or scanned materials (Republican China vertical-layout texts, old gazetteers, etc.), where one keyword often drowns in noise.

Chinese trad/simp folding: keyword `search`, `search-in`, and `metadata` match across 繁 ↔ 简 both ways (黨組書記 ≡ 党组书记), so one form is enough. `search --semantic` does NOT fold — pick the likely source form.

## Typical workflows

### Find passages, then retrieve surrounding context

```bash
# Search across the library
zotagent search "party secretary governance" --limit 10

# Expand around a returned hit
zotagent expand --key KG326EEI --block-start 134 --radius 2

# Read the whole document
zotagent fulltext --key KG326EEI --clean
zotagent fulltext --key lee2024party --clean

# Or page through blocks
zotagent blocks --key KG326EEI --offset-block 120 --limit-blocks 30
```

### Drill into one paper with `search-in`

`search-in` is the right tool whenever the user has already pinned a specific item — "does this book cite X?", "find Y in chapter 3", "where does the author talk about Z in the paper I just opened?". It runs the same FTS5 syntax as `search` but evaluates the query per block, so each returned passage individually satisfies the query rather than being a doc-level approximation.

```bash
# "Does this book cite Acemoglu's 2012 work?" — start with the bare surname.
# In-text references use the parenthetical form (Acemoglu and Robinson 2012)
# while the bibliography entry uses Acemoglu, Daron. 2012. — the bare token
# matches both. Reach for a full quoted citation only to verify the exact
# title or to disambiguate when one author has multiple bibliography entries
# (multi-token quoted phrases also catch citations that wrap across paragraph
# breaks in the references list).
zotagent search-in 'Acemoglu' --key CMJ3N8TL --limit 10
zotagent search-in '"Acemoglu, Daron. 2012"' --key CMJ3N8TL --limit 5

# Proximity inside a single paper — find blocks where two anchor terms co-occur
# within 20 tokens. Far more precise than plain keyword on dense academic prose.
zotagent search-in '"property rights" NEAR/20 "credibility"' --key CMJ3N8TL --limit 10

# Prefix wildcard for surname or stem variants — matches Peter, Petersen, Peterson...
zotagent search-in 'Pete*' --key CMJ3N8TL --limit 10

# Combine with expand to pull the full paragraph around a hit
zotagent expand --key CMJ3N8TL --block-start 2192 --radius 1
```

If `search-in` returns nothing for a citation-style query, do not silently widen — say "not cited in this attachment" and offer to try a looser shape (drop the year, prefix the surname, switch to `search` across the whole library).

`search-in --limit` defaults to 10 and rarely needs to go higher: you are already scoped to one document. The limit truncates the result list, not the underlying FTS search, so re-running the same query with a bigger `--limit` can never reveal hits that the first call missed — if the count looks short, change the query, not the limit.

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
zotagent blocks --key KG326EEI --limit-blocks 40
zotagent fulltext --key KG326EEI --clean
```

## Citing passages

When you quote or paraphrase material from `search` / `search-in` / `expand` / `blocks` / `fulltext`, cite in **Pandoc source form** using the returned `itemKey` and the block index as locator:

- With locator: `[@itemKey, block N]` — single block or a range like `block 3-7`
- Narrative reference without locator: `@itemKey`

`N` is `blockStart` (or `blockIndex` in `expand` / `blocks`).

Examples (given `itemKey: "KG326EEI"`, `blockStart: 3`, `blockEnd: 7`):
- `[@KG326EEI, block 3]`
- `[@KG326EEI, block 3-7]`

Do not cite `pageStart` / `pageEnd`. They appear in `expand` / `blocks` output but are unreliable (PDF extraction drift; EPUB has none) — use the block index.

## Output-shape gotchas

- **`passage` is a ~500-token snippet** — the trailing `…` means truncation. Before quoting or treating it as evidence, call `expand --key <k> --block-start <blockStart> --block-end <blockEnd>` to get the full block text. Use `--radius 0` for just the hit; default is 2.
- **`metadata` omits `abstract` by default** to keep bulk responses compact. Pass `--abstract` when you need it.
- **`--key` accepts `itemKey` or `citationKey`**, with or without a leading `@` (so Pandoc `@citekey` pastes straight in). Output always identifies items by `itemKey` only — `citationKey` is accepted as input but never emitted, so chain subsequent calls on `itemKey`.
- **Block indices are item-global.** When an item has multiple indexed attachments, indices run monotonically across them with `# Attachment: <name>` dividers. Pass `blockStart` from `search` straight into `blocks` / `expand`.
- **`search-in` on a chapter key may miss.** `SEARCH_IN_FAILED: No indexed attachment found` usually means the chapter's PDF is indexed only inside its parent volume. Look the parent up with `metadata`, then `search-in` against the parent's key and locate the chapter by its heading. Common for edited collections and proceedings.
- **`search-in` returns block-level matches; `search` returns one passage per item.** A `search-in` result means *this block* satisfies the query (operators included). A `search` result means *this document* matches and here is one representative passage. When the user asks "does this paper say X" or "where in this paper does Y appear", reach for `search-in`.

## Index freshness

`search` / `search-in` / `blocks` / `expand` / `fulltext` read a local index. On `NO_INDEX` or "No indexed documents found", suggest `zotagent sync`. `metadata` / `add` / `s2` work without the index. After `add`, the new paper isn't full-text searchable until the next `sync`.

If you need a command or flag not covered here, run `zotagent help`.
