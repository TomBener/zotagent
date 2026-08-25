# Plan 008: Annotate Semantic Scholar rows with `inLibrary` + `itemKey`

> **Executor instructions**: This is a stub, not a ready-to-run plan. Read
> "Open questions" before writing code, and expand this file into full steps
> (current state with verified line numbers, test list, done criteria) the way
> plans 001-007 are written. If anything in "STOP conditions" holds, stop and
> report.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MEDIUM (touches the sync pipeline's record shape)
- **Depends on**: none (the citation-graph commands it builds on already ship)
- **Category**: feature
- **Planned at**: commit `994b1ae`, 2026-08-25

## Why this matters

`s2`, `s2-refs`, and `s2-citations` are the discovery surface: an agent walking
a bibliography gets 50 candidate papers and no way to tell which ones the user
already owns. Today it must issue one `metadata` call per row to find out —
expensive, fuzzy (title matching), and usually skipped, so the agent proposes
`add` for papers already in Zotero, or re-reads a paper it could have opened
with `fulltext`.

The join key is right there: every Semantic Scholar row carries `doi`, and
Zotero stores a DOI per item. Annotating each row with `inLibrary: true` and
the local `itemKey` turns citation chaining into a two-way tool — "you cite
these 40 papers, you own 12 of them, here are the 28 you don't."

## Current state (verified at `994b1ae`)

- `BibliographyRecord` (`src/types.ts`) has **no `doi` field**. The bibliography
  loader in `src/catalog.ts` reads Better CSL JSON, which does carry `DOI`, but
  the field is dropped on the way into the record.
- `MetadataSearchResultRow` likewise has no DOI, so no existing local lookup
  can answer "which item has this DOI".
- Semantic Scholar rows already expose `doi` when the API has one
  (`extractDoi` in `src/s2.ts`), so the remote half of the join is done.
- `fetchPaperLinks` in `src/s2.ts` builds rows in one place, and
  `searchSemanticScholar` in another — an annotation pass would wrap both.

## Sketch

1. Add `doi?: string` to `BibliographyRecord` and populate it in the
   bibliography loader (cleaned via `cleanDoi`, lowercased for matching).
2. Build a DOI → `itemKey` map when the catalog loads; keep it out of the hot
   path for commands that never need it.
3. In the `s2` / `s2-refs` / `s2-citations` CLI cases, annotate rows with
   `...(hit ? { inLibrary: true, itemKey: hit } : {})` — absent, not `false`,
   for rows with no match, matching the repo's optional-field convention.
4. Document the new fields in help text, README, and SKILL.md in the same
   change (repo rule), and say plainly that a row without `inLibrary` means
   "no DOI match", not "definitely not in the library".

## Open questions

- **DOI-only, or fall back to title matching?** DOI is exact and cheap; title
  matching is fuzzy and would make `inLibrary` untrustworthy. Recommendation:
  DOI only, and document the limitation.
- **Where does the annotation belong** — inside `src/s2.ts` (which would then
  depend on the local catalog, breaking its "transport only" shape) or in a
  thin CLI-side decorator? Recommendation: the decorator.
- **Cost of loading the catalog** for a command that currently needs no local
  index. `s2` works on a machine that has never synced; the annotation must
  degrade to "no annotation" rather than failing, and must not warn loudly.
- Should `metadata` gain a `--doi` filter out of the same DOI map?

## STOP conditions

- The bibliography export in use does not carry DOI values (check a real
  `bibliography.json` before building on the assumption).
- Adding `doi` to `BibliographyRecord` would force an index rebuild — check
  `indexerSignature` handling in `src/state.ts` first and decide deliberately.
