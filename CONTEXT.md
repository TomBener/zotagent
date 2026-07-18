# zotagent Domain Glossary

Names for the concepts the code is organized around. Use these words in code,
tests, commits, and reviews — one name per concept.

## Extraction & storage

- **Attachment** — one file (PDF/EPUB/HTML/TXT) belonging to a Zotero item.
  Identified across syncs by its **docKey**.
- **docKey** — the stable identity of one attachment's extracted content, and
  the key under which its artifact is stored.
- **Artifact** — the pair produced by extracting one attachment: the
  *normalized markdown* (`normalized/<docKey>.md`) and the *manifest*
  (`manifests/<docKey>.json.gz`). Always written, moved, validated, and deleted
  as a pair; a half-written pair must never be observable.
- **Normalized markdown** — the plain-markdown rendering of an attachment's
  text, the substrate for keyword and semantic indexing.
- **Manifest** — the block-level structure of one attachment: text blocks with
  section paths, page numbers, and char/line offsets. Carries the
  `verticalText` marker for PDFs.
- **Artifact Store** — the module that owns artifacts: the docKey→file
  mapping, staged pair publishes (publish-or-restore), the reuse verdict,
  rename adoption, tolerant discard, and the per-sync sweep (stale pairs,
  staging residue, and hex-keyed orphans no catalog references — never
  files whose names don't match the docKey shape). It speaks
  only in docKeys, identities, and verdicts — it never touches source files
  and never knows Zotero exists. Lives in `src/artifact-store.ts`; sync,
  engine, diagnose, and the keyword index all go through it.
- **Reuse verdict** — the store's answer to "may this cached artifact stand
  in for re-extraction?": pair complete, normalized non-empty, manifest
  readable with blocks, identity (docKey + itemKey) matches, and — for PDFs —
  the recorded vertical-text marker matches the current tag verdict.
  Refusals carry a reason (missing / empty-normalized / unreadable-manifest /
  no-blocks / identity-mismatch / vertical-mismatch).

## Sync

- **Catalog** — `catalog.json`: the persisted record of every attachment's
  extraction lifecycle (`extractStatus`: ready / missing / unsupported /
  error) plus the index-completion markers (`indexesCompletedAt`,
  `indexerSignature`, `indexedQmdEmbedModel`).
- **Triage** — the per-attachment decision phase of a sync run: reuse the
  existing artifact, migrate it from a renamed attachment, re-extract, skip a
  known error, or record the attachment as missing/unsupported. The decision
  itself is the pure table in `src/triage.ts` (facts in, verdict out); the
  sync loop gathers facts and performs the effects.
- **Rename migration** — carrying an existing artifact over to a new docKey
  when the same file (itemKey + size + mtime) reappears under a new path,
  instead of re-extracting and re-embedding. Candidate matching is triage's
  job (bibliography knowledge); the artifact-side half is the store's
  **adoption**: move the pair, rewrite the manifest identity, preserve the
  vertical-text marker and blocks, refuse before moving when the vertical
  verdict disagrees.
- **Vertical text** — a Zotero-tag-driven verdict (`zotagent:vertical`,
  configurable via `verticalTextTag`) that a PDF is vertical CJK. Drives
  extraction with reading-order off and is recorded on the manifest; an
  artifact is only reusable if its recorded verdict matches the current tag.
- **Exclusion tag** — the Zotero tag (`zotagent:exclude`, configurable via
  `excludeTag`) whose items sync skips entirely.
- **Indexer signature** — a stable hash of the indexer implementations
  (keyword schema, qmd package, opencc version, embed model sentinel); any
  mismatch with the catalog's recorded signature invalidates the indexes.
  What a mismatch *means* (rebuild vs re-embed vs short-circuit) is the pure
  policy in `src/index-policy.ts`.
- **Extraction pipeline** — `src/extract.ts`: tier fallback (ODL structured →
  ODL text-only → pdftotext), batch grouping, and the vertical-text rule,
  which the dispatcher resolves exactly once per batch — tiers receive a
  plain verdict, never the tag set.

## Add

- **Add intake** — the pipeline behind `zotagent add`: every input kind
  (manual fields, DOI, web page, identifier, Semantic Scholar paperId, JSON
  batch) produces a Zotero item payload that flows through one shared write
  tail (create → child notes → attachment → agent tag → result). `runAdd` /
  `runAddJson` in `src/add.ts` are the entry points the CLI calls; pure
  metadata mapping (CSL→Zotero types, DOI hygiene, author parsing, title
  splitting) lives in `src/item-metadata.ts`.

## Search

- **Keyword index** — the FTS5 sqlite index over manifest blocks.
- **Semantic index** — the qmd vector store over normalized markdown.
- **Passage** — the reflowed, token-capped text around a search hit, anchored
  to a char offset and (where available) page numbers.
