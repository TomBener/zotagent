---
name: zotagent
description: Search, read, or add Zotero literature via the local `zotagent` CLI. Load this skill whenever the user wants to query their Zotero library (keyword / semantic / metadata), pull quotations or context from indexed papers, add new items by DOI or Semantic Scholar paperId, or resolve bibliographic metadata. Do not guess at zotagent's flags — consult this reference first.
---

# zotagent

`zotagent` is a one-shot CLI over a local index of Zotero attachments (PDF / EPUB / HTML / TXT). Each invocation is independent. All commands emit JSON on stdout with the envelope `{"ok": bool, "data" | "error", "meta"?: {"elapsedMs": n}}`.

## Three search layers — pick the right one

| Command | Searches over | Good for |
|---|---|---|
| `zotagent search "<q>" [--semantic] [--limit n] [--min-score n]` | Indexed full text (FTS5 keyword by default; vector + LLM query expansion with `--semantic`) | Finding passages that discuss a topic across the library |
| `zotagent search-in "<q>" (--item-key <k> \| --citation-key <k>) [--limit n]` | Full text of one item's attachments | Drilling into a single paper for a term |
| `zotagent metadata "<q>" [--field f] [--abstract] [--has-file] [--limit n]` | Bibliography fields: title / author / year / journal / publisher / abstract | Finding papers by metadata, verifying existence, resolving an `itemKey` |

Keyword syntax (default `search`): `"exact phrase"`, `OR`, `NOT`, `term NEAR/50 term`, `prefix*`. `NEAR(...)` syntax is **not** accepted; use `NEAR/<n>`.

## Typical workflows

### Find passages, then read surrounding context

```bash
# 1. Broad keyword search
zotagent search "party secretary governance" --limit 10

# 2. A row comes back with itemKey, blockStart, blockEnd, passage (see "Output gotchas" below).
#    Pull surrounding context (radius = 2 blocks before/after):
zotagent expand --item-key KG326EEI --block-start 134 --radius 2

# 3. Or read the whole document:
zotagent fulltext --item-key KG326EEI --clean

# 4. Or paginate blocks:
zotagent read --item-key KG326EEI --offset-block 120 --limit-blocks 30
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

`add` is speed-first and does NOT dedupe against the existing Zotero library. New items are tagged `Added by AI Agent`. It returns `itemKey` immediately.

### Look up a paper's metadata / itemKey

```bash
# Multi-field search (title OR abstract)
zotagent metadata "aging in China" --field title --field abstract

# Include the full abstract in the response (suppressed by default)
zotagent metadata "aging in China" --abstract

# Only items that have an indexed attachment
zotagent metadata "dangwei shuji" --has-file
```

## Output-shape gotchas

These are the most common surprises when consuming `zotagent` output. Read them before parsing results.

- **`passage` is capped at 500 tokens**, measured via `o200k_base` (a close proxy for Claude's tokenizer). Every `search` / `search-in` / `search --semantic` row has its `passage` field truncated to ~500 tokens. A trailing `…` signals truncation. To see more text:
  - For the same blocks only: `expand --item-key <k> --block-start <blockStart> --block-end <blockEnd> --radius 0`
  - For surrounding context: add `--radius <n>` (default 2); the response grows linearly in block count, not characters.
  - Do NOT try to extract the full quotation from `passage` alone; always `expand` if you need guaranteed-complete text.
- **`metadata` omits `abstract` by default.** To keep bulk responses compact, the `abstract` field is stripped. Pass `--abstract` to include it. If a script expects `abstract` to always be present, add the flag or handle the missing case.
- **`itemKey` is the stable primary id; `citationKey` is a mutable display field.** Prefer `itemKey` for anything that persists across time. Both commands that take a selector accept either via `--item-key` or `--citation-key`, but don't rely on `citationKey` matching any previous run.
- **Block indices are item-global.** When an item has multiple indexed attachments (e.g. PDF + EPUB), block indices are monotonic across them with `# Attachment: <name>` dividers. Pass block indices straight from `search` into `read` / `expand` — don't translate them.
- **Every command — including errors — emits a JSON envelope.** On failure: `{"ok": false, "error": {"code": "...", "message": "..."}}` and a non-zero exit code. Missing credentials fail fast.

## Pre-requisites

- `search` / `search-in` / `read` / `expand` / `fulltext` all work on a local index built by `zotagent sync`. If a query returns `NO_INDEX` or "No indexed documents found", run `zotagent sync` first.
- `add` / `s2` / `metadata` do NOT require the local index and work even before the first sync.
- Config lives at `~/.zotagent/config.json` (paths, Zotero Web API key, Semantic Scholar API key). Any field can also come from `ZOTAGENT_*` env vars.
- `sync` needs Java (JDK 11+) for PDF extraction via OpenDataLoader. `pdftotext` is an optional fallback.

## Common errors

| Error code | What it means | Fix |
|---|---|---|
| `NO_INDEX` | Search ran before `sync` | Run `zotagent sync` |
| `SYNC_DISABLED` | Host is marked read-only (shared `dataDir` via iCloud) | Expected — run `sync` on the primary host only |
| `MISSING_ARGUMENT` / `INVALID_ARGUMENT` | Malformed flags | Check flags via `zotagent help` |
| `UNEXPECTED_ARGUMENT` | Flag not supported by the given command (each command has its own allow-list) | Consult the help text for that command |
| Missing API key errors | `semanticScholarApiKey` / `zoteroApiKey` not set | Add to `~/.zotagent/config.json` or env |

## When not to use zotagent

- Full-text search outside the Zotero library → use `rg` / `grep`.
- Bibliography management that needs Zotero GUI features (collections, tags UI) → use Zotero directly.
- Web search for papers not in the library → prefer `s2` (Semantic Scholar) over a web fetch; if `s2` misses, then web search.
