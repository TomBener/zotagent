---
name: zotlit
description: Use this skill whenever the user wants to search indexed Zotero PDFs with zotlit, inspect hits, read blocks from an indexed attachment, expand context around a hit, or turn zotlit results into Markdown notes that keep the itemKey. Use it whenever the user mentions Zotero literature search, exact phrase search, passages, itemKey, block ranges, or cited notes from zotlit results.
---

# zotlit

`zotlit` is a CLI for searching indexed Zotero PDFs.

## Main use

For most agent tasks, use this path:

1. `zotlit search "<text>"`
2. If the user wants a literal phrase, add `--exact`
3. Take the returned `file` and `blockStart`, then run `zotlit expand`
4. Use `zotlit read` when the user wants a larger block slice from one indexed attachment

`sync` is secondary. Use it only when the user explicitly wants to rebuild or refresh the index.

## Commands

### Search

```bash
zotlit search "state-owned enterprise governance"
zotlit search "dangwei shuji" --exact
zotlit search "industrial policy" --limit 5 --min-score 0.4
zotlit search "how do party secretaries shape SOE governance" --rerank
zotlit search "industrial policy" --no-rerank
```

Rules:

- search text is positional
- do not use `--query`
- `--exact` is for exact phrase search
- `--exact` cannot be combined with `--rerank`

### Expand

```bash
zotlit expand --file "/absolute/path/to/file.pdf" --block-start 133
zotlit expand --file "/absolute/path/to/file.pdf" --block-start 133 --block-end 133 --radius 1
```

Rules:

- `expand` currently requires `--file`
- `--block-start` is required
- `--block-end` defaults to `block-start`

### Read

```bash
zotlit read --item-key KG326EEI
zotlit read --file "/absolute/path/to/file.pdf" --offset-block 20 --limit-blocks 10
```

Rules:

- use either `--file` or `--item-key`
- if one `itemKey` maps to multiple indexed attachments, switch to `--file`

### Status

```bash
zotlit status
```

Use `status` when the user wants paths, counts, or wants to check whether the index looks ready.

### Sync

```bash
zotlit sync
zotlit sync --attachments-root "/absolute/path/to/a/zotero/subfolder"
```

Rules:

- `sync` does not accept a positional folder path
- use `--attachments-root` for a Zotero subfolder

## Important fields

### `itemKey`

The Zotero item identifier for the work.

Use it as the source handle in Markdown notes and citations.

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

When turning zotlit results into Markdown, keep:

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

### No search results

Check:

1. `zotlit status`
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

