---
name: zotagent
description: Use this skill whenever the user wants to use zotagent to add Zotero items, search indexed Zotero documents (PDF, EPUB, HTML), inspect hits, read blocks from an indexed attachment, expand context around a hit, or turn zotagent results into Markdown notes that keep the itemKey. Use it whenever the user mentions Zotero literature search, DOI import, exact phrase search, passages, itemKey, block ranges, or cited notes from zotagent results.
---

# zotagent

`zotagent` is a CLI for AI-agent Zotero workflows: add items, search indexed documents (PDF, EPUB, HTML), search metadata, and read local passages.

## Main use

For most agent tasks, use this path:

1. If the user wants to add a source to Zotero, use `zotagent add`
2. For literature search, start with `zotagent metadata` to find high-confidence title, abstract, author, journal, publisher, and year matches
3. Then use `zotagent search --exact` for key phrases in indexed full text
4. Use default `zotagent search` last for fast semantic full-text recall and missed wording
5. Take the returned `file` and `blockStart`, then run `zotagent expand`
6. Use `zotagent read` when the user wants a larger block slice from one indexed attachment

`sync` is secondary. Use it only when the user explicitly wants to rebuild or refresh the index.

Query planning is the agent's job. If the user asks for Chinese and English literature, generate English search terms yourself; zotagent does not translate queries or decide bilingual coverage.

Do not run multiple default qmd `zotagent search` commands in parallel. It is OK to parallelize `metadata`, `search --exact`, and `expand`.

## Commands

### Add

```bash
zotagent add --doi "10.1111/dech.70058"
zotagent add --title "Working Paper Title" --author "Jane Doe" --year 2026 --publication "Working Paper Series"
```

Rules:

- use `--doi` when the user has a DOI
- use manual fields when there is no DOI or the user wants to create a basic record directly
- `add` is speed-first and does not do Zotero-side duplicate checking
- newly created items receive the tag `Added by AI Agent`
- `add` returns `itemKey` immediately; use that as the citation handle
- creating an item in Zotero does not make it instantly available to local PDF search; `metadata` depends on exported bibliography JSON and PDF search depends on `sync`

### Search

```bash
zotagent search "state-owned enterprise governance"
zotagent search "dangwei shuji" --exact
zotagent search "industrial policy" --limit 5 --min-score 0.4
zotagent search "how do party secretaries shape SOE governance" --rerank
```

Rules:

- search text is positional
- do not use `--query`
- `--exact` is for exact phrase search
- use default `search` after metadata and `--exact`, not as the first pass
- `--exact` cannot be combined with `--rerank`
- default `search` skips qmd rerank; add `--rerank` only for a narrower query when ranking quality matters more than latency
- avoid parallel default qmd searches; run them one at a time

### Expand

```bash
zotagent expand --file "/absolute/path/to/file.pdf" --block-start 133
zotagent expand --file "/absolute/path/to/file.pdf" --block-start 133 --block-end 133 --radius 1
```

Rules:

- `expand` currently requires `--file`
- `--block-start` is required
- `--block-end` defaults to `block-start`

### Read

```bash
zotagent read --item-key KG326EEI
zotagent read --file "/absolute/path/to/file.pdf" --offset-block 20 --limit-blocks 10
```

Rules:

- use either `--file` or `--item-key`
- if one `itemKey` maps to multiple indexed attachments, switch to `--file`

### Status

```bash
zotagent status
```

Use `status` when the user wants paths, counts, or wants to check whether the index looks ready.

### Metadata

```bash
zotagent metadata "Development and Change" --field journal
```

Use `metadata` when the user wants bibliography matches and does not need full-text PDF search.

For literature search, use `metadata` first. It searches Zotero-exported bibliography fields, including abstract, and is usually cheaper than full-text search.

### Sync

```bash
zotagent sync
zotagent sync --attachments-root "/absolute/path/to/a/zotero/subfolder"
```

Rules:

- `sync` does not accept a positional folder path
- use `--attachments-root` for a Zotero subfolder

## Important fields

### `itemKey`

The Zotero item identifier for the work.

Use it as the source handle in Markdown notes, citations, and follow-up Zotero references after `add`.

### `file`

The concrete attachment path.

Use it for follow-up commands such as `expand` or `read --file`.

### `blockStart` and `blockEnd`

The matched block range in the local manifest.

They are not page numbers.

Use them to:

- expand around a hit
- record where a quote or claim came from

### `passage`

The text from the matched block range.

It comes from extracted text blocks, so it can differ slightly from the PDF's visual paragraphing.

## Markdown notes

When turning zotagent results into Markdown, keep:

- the claim or quote
- the `itemKey`
- the block range

Example:

```md
- Claim: Party secretaries sit at the top of the replicated leadership structure inside major Chinese SOEs.
- Source itemKey: KG326EEI
- Blocks: 133-133
```

Use `file` only when a follow-up CLI command needs it.

## Troubleshooting

### Added item does not appear in search

`add` writes to Zotero immediately, but local search state is separate.

Check:

1. whether the exported bibliography JSON has refreshed
2. whether the item has a PDF attachment under the configured attachments root
3. whether `zotagent sync` has been run after the attachment is available

### No search results

Check:

1. `zotagent status`
2. whether attachments are ready
3. whether the query should use `--exact`

### Passage is wider than expected

`passage` is built from extracted text blocks, not from a separate snippet generator.

### `read --item-key` fails

That usually means multiple indexed attachments share the same `itemKey`. Use `--file` instead.

## Output style

- prefer concise, practical answers
- show the exact command when syntax matters
- do not dump full JSON unless the user asked for it
- pull out `itemKey`, `file`, `blockStart`, `blockEnd`, and `passage` when they drive the next step
- when `add` is used, report `itemKey`, `title`, and any warnings
