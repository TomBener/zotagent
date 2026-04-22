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
| `zotagent search "<q>" [--semantic] [--limit n] [--min-score n]` | Indexed full text (FTS5 keyword by default; vector + LLM query expansion with `--semantic`) | Finding passages that discuss a topic across the library |
| `zotagent search-in "<q>" --key <k> [--limit n]` | Full text of one item's attachments | Drilling into a single paper for a term |
| `zotagent metadata "<q>" [--field f] [--abstract] [--has-file] [--limit n]` | Bibliography fields: title / author / year / journal / publisher / abstract | Finding papers by metadata, verifying existence, resolving an `itemKey` |

Keyword syntax (default `search`): `"exact phrase"`, `OR`, `NOT`, `term NEAR/<n> term`, `prefix*`. Use `NEAR/<n>` not `NEAR(...)`.

**`NEAR/<n>` is the most useful operator** when you have 2–3 anchor terms that should co-occur but not necessarily adjacent — e.g. `"土地" NEAR/20 "垦荒"` catches passages discussing both regardless of phrasing. More precise than plain keyword, far faster than `--semantic`. Reach for it first whenever you have anchor terms.

`NEAR/<n>` is especially valuable on OCR'd or scanned materials (Republican China vertical-layout texts, old gazetteers, etc.), where OCR noise makes `--semantic` unreliable and any single keyword drowns in hits — co-occurrence anchors cut through.

Keyword vs semantic heuristic: keyword (with NEAR and exact phrases) first for named concepts, anchor terms, or quotations (`"terra nullius"`, `"empty land" OR "wasteland"`); switch to `--semantic` when phrasing is fuzzy or you want conceptual neighbors. The two layers return overlapping but distinct sets — for a thorough sweep, running both and merging is often worth the extra call.

Chinese trad/simp folding: keyword `search`, `search-in`, and `metadata` match across 繁 ↔ 简 both ways (黨組書記 ≡ 党组书记), so one form is enough. `search --semantic` does NOT fold — pick the likely source form.

## Typical workflows

### Find passages, then retrieve surrounding context

```bash
# 1. Broad keyword search
zotagent search "party secretary governance" --limit 10

# 2. A row comes back with itemKey (and citationKey if available), blockStart, blockEnd, passage
#    (see "Output gotchas" below). Pull surrounding context (radius = 2 blocks before/after):
zotagent expand --key KG326EEI --block-start 134 --radius 2

# 3. Or retrieve the whole document — --key accepts itemKey or citationKey:
zotagent fulltext --key KG326EEI --clean
zotagent fulltext --key lee2024party --clean

# 4. Or paginate blocks:
zotagent blocks --key KG326EEI --offset-block 120 --limit-blocks 30
```

### Add a paper to Zotero

```bash
# Best path: you have a DOI.
zotagent add --doi "10.1111/dech.70058"

# Otherwise: search Semantic Scholar, then add by paperId.
zotagent s2 "state-owned enterprise governance" --limit 5
zotagent add --s2-paper-id <paperId>

# Manual entry fallback.
zotagent add --title "..." --author "Last, First" --year 2026 --publication "Journal"
```

### Look up a paper's metadata / itemKey

```bash
# Multi-field search (title OR abstract)
zotagent metadata "aging in China" --field title --field abstract

# Include the full abstract in the response (suppressed by default)
zotagent metadata "aging in China" --abstract

# Only items that have an indexed attachment
zotagent metadata "dangwei shuji" --has-file

# `metadata` matches the whole query as a substring against each field,
# so author + year in one string never hits. Search one anchor and read
# `year` off the returned JSON to filter by year yourself:
zotagent metadata "Pratt" --field author

# Pipe the returned key into blocks / fulltext for the paper body
zotagent blocks --key KG326EEI --offset-block 0 --limit-blocks 40
zotagent fulltext --key KG326EEI --clean
```

## Output-shape gotchas

- **`passage` is a ~500-token snippet** — the trailing `…` signals truncation. Scanning is fine; before quoting it verbatim or treating it as evidence, call `expand --key <k> --block-start <blockStart> --block-end <blockEnd>` to get the complete block text (`--radius 0` for the hit only, `--radius n` for surrounding context, default 2). This matters because a sentence at the cut may be halved, and `passage` can't show you whether the author is stating their own view or paraphrasing someone else — `expand` can.
- **`metadata` omits `abstract` by default** to keep bulk responses compact. Pass `--abstract` when you need it.
- **`--key` accepts `itemKey` or `citationKey`**, with or without a leading `@` (so Pandoc `@citekey` pastes straight in). Every response returns both. Prefer `itemKey` when persisting a reference — `citationKey` can change if someone renames it in Zotero.
- **Block indices are item-global.** When an item has multiple indexed attachments, indices run monotonically across them with `# Attachment: <name>` dividers. Pass `blockStart` from `search` straight into `blocks` / `expand`.
- **`search-in` on a chapter key may miss.** `SEARCH_IN_FAILED: No indexed attachment found` usually means the chapter's PDF is indexed only inside its parent volume. Look the parent up with `metadata`, then `search-in` against the parent's key and locate the chapter by its heading. Common for edited collections and proceedings.

## Index freshness

`search` / `search-in` / `blocks` / `expand` / `fulltext` read a local index. On `NO_INDEX` or "No indexed documents found", suggest `zotagent sync`. `metadata` / `add` / `s2` work without the index. After `add`, the new paper isn't full-text searchable until the next `sync`.
