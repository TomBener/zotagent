# Plan 005: Keyword indexing skips unreadable manifests instead of aborting the whole sync

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9b80ba6..HEAD -- src/keyword-db.ts src/sync.ts src/utils.ts tests/unit/keyword-db.test.ts tests/unit/sync.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW-MED
- **Depends on**: 001 (CI runs tests — so this fix is gated on PRs)
- **Category**: bug
- **Planned at**: commit `9b80ba6`, 2026-07-03

## Why this matters

During keyword indexing, every catalog entry's manifest (`.json.gz`) is read
with the *throwing* reader. One corrupt or truncated manifest therefore aborts
the entire keyword build inside its SQLite transaction, sync exits before
`indexesCompletedAt` is written, and the next sync sets `keywordRebuildNeeded`
and hits the same corrupt file again — a permanent, total block on the default
search path that only manual file deletion can clear. A non-throwing reader
(`tryReadManifestFile`) already exists for exactly this. The fix: skip
unreadable manifests, report which docKeys were skipped so sync can log a
warning with a remediation hint.

## Current state

- `src/keyword-db.ts:134-140` — the throwing read on the index path:

  ```ts
  function indexedBlocksForEntry(entry: CatalogEntry): Array<{ blockIndex: number; indexed: string }> {
    if (!entry.manifestPath || !exists(entry.manifestPath)) return [];
    const manifest = readManifestFile(entry.manifestPath);
    return manifest.blocks
      .map((block) => ({ blockIndex: block.blockIndex, indexed: segmentCjk(toSimplified(block.text)) }))
      .filter((b) => b.indexed.length > 0);
  }
  ```

  Called from `upsertEntry` (`src/keyword-db.ts:173`, used by `updateTable`)
  and `rebuildTable` (`src/keyword-db.ts:206`), both executed inside
  `db.transaction(...)` wrappers created in `openKeywordIndex`
  (`src/keyword-db.ts:371-384`).

- `src/utils.ts:58-65` — the non-throwing reader to use:

  ```ts
  export function tryReadManifestFile(path: string): AttachmentManifest | undefined {
    if (!existsSync(path)) return undefined;
    try {
      return readManifestFile(path);
    } catch {
      return undefined;
    }
  }
  ```

- `src/keyword-db.ts:28-39` — the client interface whose two mutation methods
  change return type in this plan:

  ```ts
  export interface KeywordIndexClient {
    rebuildIndex(readyEntries: CatalogEntry[]): Promise<void>;
    updateIndex(changedEntries: CatalogEntry[], removedDocKeys: string[]): Promise<void>;
    ...
  }
  ```

- `src/sync.ts:2099-2115` — the only production call sites (inside a `try`
  whose `finally` closes the index). Current shape:

  ```ts
  if (keywordRebuildNeeded) {
    logger.info("Rebuilding keyword search index...", { console: true });
    await keywordIndex.rebuildIndex(readyEntries);
    logger.info("Compacting keyword search index...", { console: true });
    await keywordIndex.vacuum();
  } else {
    logger.info(
      `Updating keyword search index (${changedReadyEntries.length} changed, ${removedReadyDocKeys.length} removed)...`,
  ```

- Self-heal path that makes "skip" safe: sync's artifact-reuse check requires
  the manifest file to *exist* (`src/sync.ts:576-577`:
  `manifestPath && exists(manifestPath) && ...`). So the documented remediation
  — delete the corrupt `.json.gz` named in the warning and re-run `sync` —
  triggers a clean re-extraction of that attachment.

- Test fakes that must be updated with the interface: `tests/unit/sync.test.ts`
  defines inline `keywordFactory` fakes whose `rebuildIndex`/`updateIndex`
  return `Promise<void>` (e.g. `:543-545`, `:693-697`, `:852-856`; there may
  be more — find them all with
  `grep -n "rebuildIndex" tests/unit/sync.test.ts`). TypeScript will flag every
  fake that needs the new return value; fix them mechanically.

- Repo conventions: sync warnings go through the injected `SyncLogger` —
  `logger.warn(...)` as at `src/sync.ts:826`. `keyword-db.ts` itself has no
  logger; that is why skipped docKeys are *returned*, not logged in place.

## Commands you will need

| Purpose    | Command                                          | Expected on success |
|------------|--------------------------------------------------|---------------------|
| Typecheck  | `npm run lint`                                   | exit 0              |
| One file   | `npx tsx --test tests/unit/keyword-db.test.ts`   | all pass            |
| Sync suite | `npx tsx --test tests/unit/sync.test.ts`         | all pass            |
| Full gate  | `npm run check`                                  | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/keyword-db.ts`
- `src/sync.ts` (only the `rebuildIndex`/`updateIndex` call sites and the new
  warning log)
- `tests/unit/keyword-db.test.ts` (add cases)
- `tests/unit/sync.test.ts` (mechanically update keyword-client fakes)

**Out of scope** (do NOT touch, even though they look related):
- `src/utils.ts` — `tryReadManifestFile` is used as-is.
- The qmd/semantic indexing path (`src/qmd.ts`, embedding sections of sync) —
  same class of issue may exist there, but it is explicitly deferred.
- FTS query building, search methods, schema version string
  (`KEYWORD_INDEX_SCHEMA_VERSION` must NOT change — no on-disk format change).

## Git workflow

- Branch: `advisor/005-skip-unreadable-manifests`
- Single commit; message style matches repo history, e.g.
  `keyword-db: skip unreadable manifests instead of aborting the rebuild`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Return skipped docKeys from the mutation methods

In `src/keyword-db.ts`:

1. Change `indexedBlocksForEntry` to use `tryReadManifestFile` (import it from
   `./utils.js` — `readManifestFile` may become unused; remove it from the
   import if so). Distinguish the outcomes: file missing → keep returning `[]`
   (current behavior, means "nothing to index"); file present but unreadable →
   return `null` so callers can count it as *skipped*. Suggested signature:
   `Array<{ blockIndex: number; indexed: string }> | null`.
2. `upsertEntry`: on `null`, do nothing (leave any existing rows for that doc
   in place — stale-but-searchable beats silently vanished) and report the
   docKey as skipped. On `[]`, keep today's `deleteDoc` behavior.
3. `rebuildTable`: on `null`, skip the entry and collect its docKey; on `[]`,
   keep today's `continue`.
4. Change the interface (`src/keyword-db.ts:28-30`) and implementations so
   both mutation methods return the skipped keys:

   ```ts
   rebuildIndex(readyEntries: CatalogEntry[]): Promise<{ skippedDocKeys: string[] }>;
   updateIndex(changedEntries: CatalogEntry[], removedDocKeys: string[]): Promise<{ skippedDocKeys: string[] }>;
   ```

   The `db.transaction` wrappers in `openKeywordIndex` (`:371-384`) collect
   and return the arrays.

**Verify**: `npm run lint` → exits with errors ONLY in `src/sync.ts` and
`tests/unit/sync.test.ts` (the callers you fix next) — no errors inside
`src/keyword-db.ts` itself.

### Step 2: Log a warning from sync

At the call sites (`src/sync.ts:2101` and `:2113`), capture the result and
after each call log:

```ts
const { skippedDocKeys } = await keywordIndex.rebuildIndex(readyEntries); // or updateIndex(...)
if (skippedDocKeys.length > 0) {
  logger.warn(
    `Keyword indexing skipped ${skippedDocKeys.length} attachment(s) with unreadable manifests: ${skippedDocKeys.join(", ")}. ` +
    `Delete the corresponding manifests/<docKey>.json.gz file(s) and re-run sync to re-extract them.`,
  );
}
```

Match the existing logger style (`logger.warn` as at `src/sync.ts:826`; no
`{ console: true }` needed — warns already surface).

**Verify**: `npm run lint` → errors remain only in `tests/unit/sync.test.ts`.

### Step 3: Update the test fakes

In `tests/unit/sync.test.ts`, every inline keyword-client fake's
`rebuildIndex`/`updateIndex` must now return `{ skippedDocKeys: [] }` (e.g.
`rebuildIndex: async () => ({ skippedDocKeys: [] })`). Find them all via
`grep -n "rebuildIndex\|updateIndex" tests/unit/sync.test.ts`; change return
values only — do not alter what the fakes record or assert.

**Verify**: `npm run lint` → exit 0, and
`npx tsx --test tests/unit/sync.test.ts` → all pass.

### Step 4: Add regression tests for the skip behavior

Add to `tests/unit/keyword-db.test.ts` (see its existing helpers
`createConfig`/`readyEntry` at lines 19-53; manifests are written with
`writeManifestFile` from `../../src/utils.js`). Cases in the Test plan.
To fabricate a corrupt manifest: write non-gzip garbage bytes to the entry's
`manifestPath` with raw `writeFileSync` (any content NOT starting with the
gzip magic `0x1f 0x8b` is unreadable — see `src/utils.ts:49-52`).

**Verify**: `npx tsx --test tests/unit/keyword-db.test.ts` → all pass,
including the new cases.

### Step 5: Full gate

**Verify**: `npm run check` → exit 0.

## Test plan

New cases in `tests/unit/keyword-db.test.ts`:

1. **Rebuild skips corrupt, indexes the rest**: two ready entries, one with a
   valid manifest and one with garbage bytes at its `manifestPath`;
   `rebuildIndex` returns `{ skippedDocKeys: [<corruptKey>] }`, and
   `searchDocs` finds text from the valid entry.
2. **Update leaves existing rows when manifest turns unreadable**: index a
   valid entry; overwrite its manifest with garbage; `updateIndex([entry], [])`
   returns the docKey as skipped AND the previously indexed text is still
   searchable (stale-but-present semantics from Step 1.2).
3. **Missing manifest still deletes**: index a valid entry, delete its
   manifest file, `updateIndex([entry], [])` → skippedDocKeys empty and the
   doc is no longer searchable (protects the existing `[]`/`deleteDoc` path).

Structural pattern: the existing `openKeywordIndex` tests in the same file.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run lint` exits 0
- [ ] `npm run check` exits 0; the 3 new keyword-db cases pass
- [ ] `grep -n "tryReadManifestFile" src/keyword-db.ts` → ≥1 match
- [ ] `grep -n "readManifestFile" src/keyword-db.ts | grep -v tryRead` → no matches
- [ ] `grep -n "skippedDocKeys" src/sync.ts` → ≥2 matches (both call sites)
- [ ] `KEYWORD_INDEX_SCHEMA_VERSION` in `src/keyword-db.ts:42` is unchanged
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `src/keyword-db.ts:134-140` or the interface at `:28-39` does not match the
  excerpts above.
- Updating the sync.test.ts fakes requires changing any test's *assertions*
  (not just fake return values) — that means the interface change ripples
  further than planned.
- You find `rebuildIndex`/`updateIndex` callers outside `src/sync.ts` and the
  two test files.

## Maintenance notes

- The qmd/semantic path may read manifests with the throwing reader too —
  explicitly deferred; audit it separately (see `plans/README.md`, finding
  CORRECTNESS-03 note).
- Reviewer should scrutinize the `null` vs `[]` distinction in
  `indexedBlocksForEntry`: `null` (unreadable) must never delete existing
  rows; `[]` (missing/empty) must keep deleting them, or renamed/removed
  attachments would linger in search results.
- If a future change adds a logger to keyword-db, the returned
  `skippedDocKeys` plumbing can be simplified away.
