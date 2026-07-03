# Plan 006: Reject attachment paths that escape `attachmentsRoot` via dot segments

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9302177..HEAD -- src/catalog.ts src/utils.ts tests/unit/catalog.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `9302177`, 2026-07-03

## Why this matters

Attachment paths come from the `file` field of the bibliography JSON — data
that can originate outside the user's control (a synced Zotero group library,
an imported third-party bibliography). The containment check that decides
whether a path is "inside `attachmentsRoot`" is a string prefix match run
*before* `..` segments are resolved, so a value like
`<attachmentsRoot>/../../<anything>` passes the check while actually pointing
outside the root. Sync then reads, extracts, and indexes that file, and its
text is served to AI agents via search — a crafted bibliography can exfiltrate
arbitrary local files (including `~/.zotagent/config.json`, which holds API
keys) into agent context. The fix is a small, strict rejection: no dot
segments in attachment paths, ever — they never occur in legitimate Better
BibTeX exports.

## Current state

- `src/utils.ts:85-94` — `normalizePathForLookup` cleans a path but never
  resolves or rejects `.`/`..` segments:

  ```ts
  export function normalizePathForLookup(input: string): string {
    let out = resolveHomePath(input.trim())
      .normalize("NFC")
      .replace(/\\/g, "/")
      .replace(/\/+/g, "/");
    if (out.startsWith("/private/")) {
      out = out.slice("/private".length);
    }
    return out;
  }
  ```

- `src/catalog.ts:143-145` — the prefix-only containment check:

  ```ts
  function isWithinRoot(filePath: string, rootPath: string): boolean {
    return filePath === rootPath || filePath.startsWith(`${rootPath}/`);
  }
  ```

- `src/catalog.ts:147-151` — `splitPathSegments` drops empty segments but
  keeps `.` and `..`:

  ```ts
  function splitPathSegments(filePath: string): string[] {
    return normalizePathForLookup(filePath)
      .split("/")
      .filter((segment) => segment.length > 0);
  }
  ```

- `src/catalog.ts:177-210` — `relocateAttachmentPath`, where both vulnerable
  branches live. Branch 1 (`:184-191`) returns the raw normalized path when
  `isWithinRoot` passes; branch 2 (`:193-209`) rebuilds
  `${normalizedRoot}/${relativeSegments.join("/")}` from a matched `Zotero`
  segment tail. In both, surviving `..` segments land in `absolutePath`,
  which becomes `attachment.filePath` (`:262-278`) and is later handed to the
  PDF/EPUB/HTML extractors by sync.

  ```ts
  function relocateAttachmentPath(
    filePath: string,
    attachmentsRoot: string,
  ): { absolutePath: string; relativePath: string } | undefined {
    const normalizedPath = normalizePathForLookup(filePath);
    const normalizedRoot = normalizePathForLookup(attachmentsRoot);

    if (isWithinRoot(normalizedPath, normalizedRoot)) {
      const relativePath = normalizedPath.slice(normalizedRoot.length).replace(/^\/+/u, "");
      if (!relativePath) return undefined;
      return {
        absolutePath: normalizedPath,
        relativePath,
      };
    }
    ...
  }
  ```

- Convention: the function already returns `undefined` for unresolvable paths,
  and the caller (`loadCatalog`, `:230-236`) silently skips those entries.
  The fix uses the same mechanism — no new error channel.

## Commands you will need

| Purpose    | Command                                      | Expected on success |
|------------|----------------------------------------------|---------------------|
| Install    | `npm ci`                                     | exit 0              |
| Typecheck  | `npm run lint`                               | exit 0              |
| One file   | `npx tsx --test tests/unit/catalog.test.ts`  | all pass            |
| Full gate  | `npm run check`                              | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/catalog.ts`
- `tests/unit/catalog.test.ts`

**Out of scope** (do NOT touch, even though they look related):
- `src/utils.ts` — `normalizePathForLookup` is shared by many callers
  (manifest paths, config paths); changing its semantics is a much bigger
  blast radius than this fix needs.
- `src/sync.ts` — extraction consumes `attachment.filePath` downstream; the
  fix belongs at the catalog boundary where the untrusted data enters.
- Any behavior change for paths *without* dot segments.

## Git workflow

- Branch: `advisor/006-attachment-path-containment`
- Single commit; message style matches repo history, e.g.
  `catalog: reject attachment paths containing dot segments`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Reject dot segments at the top of `relocateAttachmentPath`

In `src/catalog.ts`, immediately after `normalizedPath` and `normalizedRoot`
are computed (`:181-182`), add an early return that rejects any candidate
path containing `.` or `..` segments, protecting both branches at once:

```ts
// Attachment paths never legitimately contain dot segments; a `..` here can
// defeat the prefix containment check below and reach outside attachmentsRoot.
if (splitPathSegments(normalizedPath).some((segment) => segment === "." || segment === "..")) {
  return undefined;
}
```

Add a brief comment as shown — this is a security boundary, and the reason
must survive refactors. Do not modify `isWithinRoot` or `splitPathSegments`.

**Verify**: `npm run lint` → exit 0.

### Step 2: Add regression tests

Add two tests to `tests/unit/catalog.test.ts`, modeled on the existing
`"loadCatalog keeps attachments inside root and marks supported file types"`
test (`:10-63`: temp dirs via `mkdtempSync`, a bibliography JSON written with
`writeFileSync`, `loadCatalog` called with `{ bibliographyJsonPath,
attachmentsRoot, dataDir, warnings: [] }`). Cases in the Test plan below.

**Verify**: `npx tsx --test tests/unit/catalog.test.ts` → all pass, including
the new cases.

### Step 3: Full gate

**Verify**: `npm run check` → exit 0.

## Test plan

New cases in `tests/unit/catalog.test.ts`:

1. **Traversal via prefix-passing path is dropped**: create a real file
   *outside* the attachments root (e.g. `join(root, "outside.pdf")`), then
   reference it in the `file` field as
   `` `${attachmentsRoot}/../outside.pdf` `` — a string that passes the
   prefix check but resolves outside. Assert the record's `attachmentPaths`
   is empty and `catalog.attachments` contains no entry for it.
2. **Normal paths are unaffected**: in the same bibliography, a sibling item
   with a legitimate `file` under `attachmentsRoot` still resolves (guards
   against over-rejection).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run lint` exits 0
- [ ] `npm run check` exits 0; the new catalog tests pass
- [ ] `grep -n '=== ".."' src/catalog.ts` → ≥1 match (the guard exists)
- [ ] All pre-existing tests in `tests/unit/catalog.test.ts` still pass unmodified
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `src/catalog.ts:177-210` does not match the excerpt above.
- Any *existing* catalog test fails after Step 1 — that would mean legitimate
  bibliographies contain dot segments and the strict-rejection approach needs
  a maintainer decision (resolve-then-check instead of reject).
- You find another entry point that turns bibliography `file` values into
  filesystem paths without going through `relocateAttachmentPath`.

## Maintenance notes

- This guard assumes all attachment-path ingestion flows through
  `relocateAttachmentPath`. If a future feature reads paths from another
  untrusted source (e.g. a JSON import that sets `filePath` directly), it
  needs the same rejection.
- Reviewer should confirm the guard runs before *both* branches (the
  prefix-check branch and the Zotero-segment-tail branch).
