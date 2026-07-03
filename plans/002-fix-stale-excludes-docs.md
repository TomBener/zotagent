# Plan 002: Fix documentation that still describes the removed `excludes.txt` mechanism

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9b80ba6..HEAD -- AGENTS.md skills/zotagent/SKILL.md src/sync.ts src/config.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `9b80ba6`, 2026-07-03

## Why this matters

Commit `f0e120a` replaced the `~/.zotagent/excludes.txt` file with a
Zotero-tag-driven exclusion mechanism, but two documents still teach the old
one. `skills/zotagent/SKILL.md` is shipped to end users via `npx skills add
TomBener/zotagent`, so AI agents are actively instructed to create an
`excludes.txt` file the tool silently ignores — actively-wrong documentation,
worse than missing. `AGENTS.md` (symlinked as `CLAUDE.md`) misleads every
contributor and coding agent the same way. The real workflow (tag items in
Zotero) is documented nowhere in either file.

## Current state

How exclusion actually works (verified against code at commit `9b80ba6`):

- Top-level Zotero items carrying the exclude tag are skipped by sync. The tag
  defaults to `zotagent:exclude` — `src/config.ts:54`:
  `excludeTag: "zotagent:exclude",` — and resolves with precedence
  CLI override → `ZOTAGENT_EXCLUDE_TAG` env var → `excludeTag` in
  `~/.zotagent/config.json` → default (`src/config.ts:213-218`).
- At sync start, `resolveExcludedItemKeys` (`src/sync.ts:847`) calls
  `fetchTaggedItemKeys` (`src/sync.ts:802`), which queries the Zotero Web API
  for top-level items with the tag. It needs Zotero read credentials
  (`zoteroLibraryId` + `zoteroApiKey`); without them the set is silently empty
  (documented in the comment at `src/sync.ts:795-801`).
- `src/excludes.ts:10-11` comment confirms: "The set is populated from a
  Zotero tag at sync start — see resolveExcludedItemKeys in sync.ts". No code
  anywhere in `src/` reads an `excludes.txt`.
- README.md already documents this correctly ("Top-level Zotero items tagged
  `zotagent:exclude` are skipped entirely by sync … The tag name can be
  customized via `excludeTag` in `~/.zotagent/config.json`"). Match its
  vocabulary.

The two stale passages:

- `AGENTS.md:8`:

  ```markdown
  - Config lives in `~/.zotagent` — `config.json` and `excludes.txt`.
  ```

- `skills/zotagent/SKILL.md:197`:

  ```markdown
  `sync` auto-loads `~/.zotagent/excludes.txt` when present: one `itemKey` or `citationKey` per line, `#` comments allowed. Use `diagnose` to find candidates such as OCR-failed scans, vertical-CJK PDFs, or multi-column gazetteers, then exclude or re-OCR them before re-syncing.
  ```

Note: `CLAUDE.md` is a symlink to `AGENTS.md` — edit `AGENTS.md` only.

## Commands you will need

| Purpose   | Command          | Expected on success |
|-----------|------------------|---------------------|
| Typecheck | `npm run lint`   | exit 0              |
| Tests     | `npm test`       | all pass            |
| Stale ref | `grep -rn "excludes.txt" AGENTS.md README.md skills/ src/ tests/` | no matches |

## Scope

**In scope** (the only files you should modify):
- `AGENTS.md`
- `skills/zotagent/SKILL.md`

**Out of scope** (do NOT touch, even though they look related):
- `src/excludes.ts` — the module is live code (imported by `src/sync.ts`),
  correctly named, and its comment is accurate.
- `README.md` — already correct on this topic.
- Any code file — this is a docs-only plan.
- `CLAUDE.md` — it is a symlink to `AGENTS.md`; do not replace it with a file.

## Git workflow

- Branch: `advisor/002-fix-stale-excludes-docs`
- Single commit; message style matches repo history, e.g.
  `docs: replace stale excludes.txt references with the exclude-tag workflow`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix `AGENTS.md:8`

Replace the line

```markdown
- Config lives in `~/.zotagent` — `config.json` and `excludes.txt`.
```

with

```markdown
- Config lives in `~/.zotagent` — `config.json`. Sync exclusions come from the Zotero tag `zotagent:exclude` (configurable via `excludeTag`), not a local file.
```

**Verify**: `grep -n "excludes.txt" AGENTS.md` → no matches.

### Step 2: Fix `skills/zotagent/SKILL.md:197`

Replace the stale paragraph (quoted in "Current state") with:

```markdown
Sync exclusions are driven by a Zotero tag, not a local file: tag a top-level item `zotagent:exclude` in Zotero and the next `sync` skips it entirely (no extraction, no indexing) and removes it from the local indexes. The tag name can be changed via `excludeTag` in `~/.zotagent/config.json` or the `ZOTAGENT_EXCLUDE_TAG` environment variable; resolving tagged items requires the Zotero read API config (`zoteroLibraryId` + `zoteroApiKey`). Use `diagnose` to find candidates such as OCR-failed scans, vertical-CJK PDFs, or multi-column gazetteers, then tag or re-OCR them before re-syncing.
```

Keep the paragraph in the same position in the document; do not renumber or
reflow neighboring sections.

**Verify**: `grep -rn "excludes.txt" skills/` → no matches, and
`grep -n "zotagent:exclude" skills/zotagent/SKILL.md` → at least one match.

### Step 3: Full gate

**Verify**: `npm run check` → exit 0 (docs changes must not break anything;
this also catches accidental code edits).

## Test plan

No new tests — docs-only change. The grep gates in the steps are the
regression check.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -rn "excludes.txt" AGENTS.md README.md skills/ src/ tests/` → no matches
- [ ] `grep -n "zotagent:exclude" AGENTS.md skills/zotagent/SKILL.md` → ≥1 match in each file
- [ ] `test -L CLAUDE.md` → exit 0 (still a symlink)
- [ ] `npm run check` exits 0
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The text at `AGENTS.md:8` or `skills/zotagent/SKILL.md:197` does not match
  the excerpts above.
- You find additional `excludes.txt` references outside the two in-scope files
  (report locations; do not expand scope yourself).
- Anything suggests an `excludes.txt` read path still exists in `src/`
  (it should not — if grep finds one, the premise of this plan is wrong).

## Maintenance notes

- If the exclusion mechanism changes again (e.g. plan for CORRECTNESS-04's
  fail-open behavior alters semantics), these two passages plus README.md must
  be updated in the same change — AGENTS.md "Development Principles" requires
  docs to move with behavior.
- Reviewer should read the new SKILL.md paragraph as an end user: it must not
  reference any config file mechanism for exclusions.
