# Plan 003: Write catalog.json atomically and degrade gracefully when it is corrupt

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9b80ba6..HEAD -- src/state.ts src/utils.ts tests/unit/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 001 (CI runs tests — so this fix is gated on PRs)
- **Category**: bug
- **Planned at**: commit `9b80ba6`, 2026-07-03

## Why this matters

`catalog.json` is the root artifact every command reads (`search`, `blocks`,
`fulltext`, `status`, `diagnose`, and `sync` itself). It is currently written
non-atomically — a plain `writeFileSync` straight to the final path — and
rewritten repeatedly during long syncs as a progress checkpoint. A crash,
`SIGKILL`, or full disk mid-write leaves truncated JSON. Reads are unguarded
(`JSON.parse` with no try/catch), so after corruption *every* command throws
`UNEXPECTED_ERROR`, including the `sync` that could rebuild it — the tool
cannot self-heal and the user must know to hand-delete the file. Every other
durable artifact in this repo already uses temp-file+rename; this plan brings
the catalog up to the same standard and makes the read path self-healing.

## Current state

- `src/state.ts:88-103` — the non-atomic write:

  ```ts
  export function writeCatalogFile(path: string, catalog: CatalogFile): void {
    const catalogPath = normalizePathForLookup(path);
    ensureParentDir(catalogPath);
    writeFileSync(
      catalogPath,
      JSON.stringify(
        {
          ...catalog,
          entries: catalog.entries.map(compactCatalogEntry),
        },
        null,
        2,
      ),
      "utf-8",
    );
  }
  ```

- `src/state.ts:70-86` — the unguarded read. Note the missing-file branch
  already defines the "empty catalog" shape, and `assertManifestsCurrent` runs
  only after a successful parse:

  ```ts
  export function readCatalogFile(path: string): CatalogFile {
    const catalogPath = normalizePathForLookup(path);
    if (!exists(catalogPath)) {
      return {
        version: 1,
        generatedAt: "",
        entries: [],
      };
    }
    const catalog = JSON.parse(readFileSync(catalogPath, "utf-8")) as CatalogFile;
    const dataDir = dataDirFromCatalogPath(catalogPath);
    assertManifestsCurrent(resolve(dataDir, "manifests"));
    return {
      ...catalog,
      entries: catalog.entries.map((entry) => hydrateCatalogEntry(entry, dataDir)),
    };
  }
  ```

- The repo's atomic-write exemplar, `src/utils.ts:67-73` — match this pattern:

  ```ts
  export function writeManifestFile(path: string, manifest: AttachmentManifest): void {
    const compact = Buffer.from(JSON.stringify(manifest), "utf8");
    const gz = gzipSync(compact, { level: 9 });
    const tmp = path + ".tmp";
    writeFileSync(tmp, gz);
    renameSync(tmp, path);
  }
  ```

- Why self-healing works downstream (no changes needed there): `sync` reads
  the previous catalog at `src/sync.ts:1368` and computes
  `keywordRebuildNeeded = !previousCatalogCompleted || indexerSignatureChanged`
  (`src/sync.ts:2071`). An empty catalog has no `indexesCompletedAt`, so the
  next `sync` performs a full rebuild. Search commands treat an empty `entries`
  array the same as "not yet synced" and answer with the existing
  no-index guidance.

- Callers of `readCatalogFile` (for awareness only — none change):
  `src/engine.ts:593,709,805,940,967,1014`, `src/diagnose.ts:121`,
  `src/sync.ts:1368`. Callers of `writeCatalogFile`: `src/sync.ts:1180,2200`,
  plus many tests (`tests/unit/engine.test.ts`, `tests/integration/cli.test.ts`).

- Semantics to preserve: `readCatalogFile` intentionally lets
  `LegacyManifestFormatError` from `assertManifestsCurrent` propagate (it
  carries a migration hint). Only the file read + `JSON.parse` become
  fault-tolerant.

## Commands you will need

| Purpose    | Command                                    | Expected on success |
|------------|--------------------------------------------|---------------------|
| Typecheck  | `npm run lint`                             | exit 0              |
| One file   | `npx tsx --test tests/unit/state.test.ts`  | all pass            |
| Full gate  | `npm run check`                            | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/state.ts`
- `tests/unit/state.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):
- `src/utils.ts` — `writeManifestFile` is the pattern to copy, not to change.
- `src/sync.ts`, `src/engine.ts`, `src/diagnose.ts` — no caller changes are
  needed; the fix is entirely inside `state.ts`.
- `assertManifestsCurrent` / `LegacyManifestFormatError` behavior.

## Git workflow

- Branch: `advisor/003-atomic-catalog`
- Single commit; message style matches repo history, e.g.
  `state: write catalog.json atomically and tolerate a corrupt file on read`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Make `writeCatalogFile` atomic

In `src/state.ts:88-103`, stage the JSON to `catalogPath + ".tmp"` and
`renameSync` it into place, mirroring `writeManifestFile` (`src/utils.ts:67-73`).
Import `renameSync` from `node:fs` alongside the existing imports at
`src/state.ts:1`. The serialized content must stay byte-identical to today
(same `JSON.stringify(..., null, 2)`, same `compactCatalogEntry` mapping,
same `"utf-8"`).

**Verify**: `npm run lint` → exit 0.

### Step 2: Make `readCatalogFile` tolerate a corrupt file

In `src/state.ts:70-86`, wrap only the `readFileSync` + `JSON.parse` in a
try/catch. On failure:

1. Move the unreadable file aside with
   `renameSync(catalogPath, catalogPath + ".corrupt")` (inside its own
   try/catch — if the rename itself fails, ignore and fall through), so the
   evidence is preserved and the next write starts clean.
2. Return the same empty-catalog object the missing-file branch returns
   (`{ version: 1, generatedAt: "", entries: [] }`).

Do NOT wrap `assertManifestsCurrent` or `hydrateCatalogEntry` — a
`LegacyManifestFormatError` must still propagate, and hydrate runs only on a
successfully parsed catalog. The corrupt-file branch returns before both,
exactly like the missing-file branch.

**Verify**: `npm run lint` → exit 0.

### Step 3: Add unit tests

Create `tests/unit/state.test.ts` with `node:test` + `assert/strict` +
`mkdtempSync(join(tmpdir(), "zotagent-state-"))`, modeled structurally on
`tests/unit/keyword-db.test.ts` (imports at lines 1-17 there). Cases are
listed in the Test plan below. A minimal valid `CatalogFile` literal for the
round-trip test can be copied from `tests/unit/engine.test.ts:51-60`
(`writeCatalogFile(join(indexDir, "catalog.json"), { version: 1, generatedAt:
..., entries: [...] })`).

**Verify**: `npx tsx --test tests/unit/state.test.ts` → all pass.

### Step 4: Full gate

**Verify**: `npm run check` → exit 0 (all existing suites still pass — the
integration suite exercises `writeCatalogFile` heavily).

## Test plan

New file `tests/unit/state.test.ts`, four cases:

1. **Round-trip**: `writeCatalogFile` then `readCatalogFile` returns the same
   entries (happy path; guards the compact/hydrate symmetry).
2. **Atomicity residue**: after `writeCatalogFile`, no `catalog.json.tmp`
   exists in the directory (`existsSync` false) and the target parses.
3. **Corrupt file degrades to empty**: write garbage (e.g. the first 20 bytes
   of a valid catalog JSON string) to `catalog.json` via raw `writeFileSync`,
   then `readCatalogFile` returns `{ version: 1, generatedAt: "", entries: [] }`
   — and the garbage file has been renamed to `catalog.json.corrupt`.
4. **Missing file unchanged**: `readCatalogFile` on a nonexistent path still
   returns the empty catalog (protects existing behavior).

Pattern exemplar: `tests/unit/keyword-db.test.ts` (temp-dir setup, plain
`test(...)` blocks, `assert.equal`/`assert.deepEqual`).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run lint` exits 0
- [ ] `npm run check` exits 0; `tests/unit/state.test.ts` exists with the 4 cases above passing
- [ ] `grep -n "renameSync" src/state.ts` → ≥2 matches (atomic write + corrupt-file move-aside)
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `src/state.ts:70-103` does not match the excerpts above.
- Any existing test fails after Step 1/2 in a way that suggests a caller
  depends on `readCatalogFile` throwing on corrupt JSON (none should — but if
  one does, the self-heal semantics need a maintainer decision).
- You find yourself wanting to change a file outside `src/state.ts` and the
  new test file.

## Maintenance notes

- `writeProgressCatalog` in `src/sync.ts` (calls at `:1180`/`:2200`) rewrites
  the catalog many times per sync; it inherits atomicity from this change
  automatically. If sync ever moves to streaming/partial catalog writes, this
  invariant must be revisited.
- Reviewer should scrutinize: the corrupt-file branch must return *before*
  `assertManifestsCurrent` (mirroring the missing-file branch), and the
  `.corrupt` rename must not be able to throw out of `readCatalogFile`.
- Deferred (out of scope): surfacing a user-visible warning when a corrupt
  catalog is detected. Today the observable signal is the `.corrupt` file plus
  a full re-index on the next sync.
