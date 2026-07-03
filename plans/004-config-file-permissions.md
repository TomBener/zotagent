# Plan 004: Write `~/.zotagent/config.json` with owner-only permissions

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9b80ba6..HEAD -- src/config-command.ts tests/unit/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 001 (CI runs tests — so this fix is gated on PRs)
- **Category**: security
- **Planned at**: commit `9b80ba6`, 2026-07-03

## Why this matters

The interactive `zotagent config` wizard persists the Zotero Web API key
(read+write access to the user's library) and the Semantic Scholar API key
into `~/.zotagent/config.json`, but writes the file with the process default
mode (typically `0644`) and the directory at `0755`. On multi-user machines
any local account can read those credentials. Standard practice for CLI
credential files (`~/.netrc`, `~/.ssh/*`, `~/.npmrc` tokens) is owner-only.
The fix is two `mode` arguments and one `chmod`, plus a note that
already-written keys should be rotated since they may have been exposed.

## Current state

- `src/config-command.ts:321-322` — the only place the config file is written
  (verified: no other `writeFileSync` in `src/` targets the config path):

  ```ts
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  ```

- The written object includes the credential fields — the wizard's field list
  at `src/config-command.ts:51-66` contains `zoteroApiKey` and
  `semanticScholarApiKey` (both marked secret and masked in *display*, but the
  file on disk is world-readable).
- Imports at `src/config-command.ts:1`:
  `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";`
- Node semantics that shape the fix: the `mode` option of `writeFileSync`
  applies only when the file is *created*; an existing file keeps its old
  mode. Likewise `mkdirSync`'s `mode` applies only to directories it creates.
  So an unconditional `chmodSync` after the write is required to fix
  already-existing installs. On Windows, `chmodSync` is a near-no-op — that
  is acceptable and needs no platform branch.
- Test conventions: `node:test` + `assert/strict`, temp dirs via
  `mkdtempSync(join(tmpdir(), ...))` — see `tests/unit/keyword-db.test.ts:1-26`
  for the exemplar. Existing config tests live in `tests/unit/config.test.ts`
  but target `src/config.ts` (resolution logic), not the wizard.

## Commands you will need

| Purpose    | Command                                            | Expected on success |
|------------|----------------------------------------------------|---------------------|
| Typecheck  | `npm run lint`                                     | exit 0              |
| One file   | `npx tsx --test tests/unit/config-command.test.ts` | all pass            |
| Full gate  | `npm run check`                                    | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/config-command.ts`
- `tests/unit/config-command.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):
- `src/config.ts` — config *reading*/resolution; permissions are a write-side
  concern.
- The wizard's prompt flow, field list, or masking logic.
- Any attempt to detect/warn about previously-exposed keys at runtime —
  rotation guidance belongs in release notes, not code (see Maintenance).

## Git workflow

- Branch: `advisor/004-config-file-permissions`
- Single commit; message style matches repo history, e.g.
  `config: write config.json with owner-only permissions`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract a testable write helper with tightened modes

In `src/config-command.ts`, replace the two lines at `:321-322` with a call to
a new exported function in the same file:

```ts
export function writeConfigFile(path: string, config: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  chmodSync(path, 0o600);
}
```

and at the original call site: `writeConfigFile(path, next);`. Add `chmodSync`
to the `node:fs` import at line 1. The serialized content (`JSON.stringify(next,
null, 2)` + trailing newline, utf-8) must remain byte-identical to today.

**Verify**: `npm run lint` → exit 0.

### Step 2: Add unit tests

Create `tests/unit/config-command.test.ts` importing `writeConfigFile` from
`../../src/config-command.js` (note the `.js` specifier convention used by all
tests). Cases in the Test plan below. Read modes with
`statSync(path).mode & 0o777`. Guard the mode assertions with
`if (process.platform !== "win32")` — the repo develops on darwin/linux and CI
runs ubuntu, but the guard keeps the test honest.

**Verify**: `npx tsx --test tests/unit/config-command.test.ts` → all pass.

### Step 3: Full gate

**Verify**: `npm run check` → exit 0.

## Test plan

New file `tests/unit/config-command.test.ts`, three cases:

1. **Fresh write**: `writeConfigFile` into a temp dir creates the parent
   directory; file mode is `0o600`, directory mode `0o700`; content parses
   back to the input object.
2. **Existing world-readable file is tightened**: pre-create the file with
   `writeFileSync(path, "{}", { mode: 0o644 })` (then `chmodSync(path, 0o644)`
   to defeat umask), call `writeConfigFile`, assert mode is now `0o600` and
   content was replaced.
3. **Content fidelity**: the written bytes equal
   `JSON.stringify(config, null, 2) + "\n"` (protects the wizard's on-disk
   format).

Pattern exemplar: `tests/unit/keyword-db.test.ts` (temp-dir setup, plain
`test(...)` blocks).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run lint` exits 0
- [ ] `npm run check` exits 0; `tests/unit/config-command.test.ts` exists with the 3 cases passing
- [ ] `grep -n "0o600" src/config-command.ts` → ≥1 match; `grep -n "0o700" src/config-command.ts` → ≥1 match
- [ ] `grep -rn "writeFileSync" src/config-command.ts` → only inside `writeConfigFile`
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `src/config-command.ts:321-322` does not match the excerpt above.
- You find a second code path in `src/` that writes the config file (the plan
  assumes there is exactly one).
- Mode assertions fail on the development platform for reasons other than
  umask (investigate once, then stop and report rather than loosening the
  assertion).

## Maintenance notes

- **Rotation**: keys written by earlier versions may have been world-readable
  on multi-user hosts. The release notes for the version shipping this change
  should recommend rotating the Zotero and Semantic Scholar API keys. (Never
  print key values anywhere while doing this.)
- Any future config writer (e.g. a non-interactive `config set` command) must
  go through `writeConfigFile` — reviewer should check no new raw
  `writeFileSync` of the config path appears later.
