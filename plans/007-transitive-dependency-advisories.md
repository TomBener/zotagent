# Plan 007: Resolve the transitive npm audit advisories under `@tobilu/qmd`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9302177..HEAD -- package.json package-lock.json`
> If either file changed since this plan was written, re-run
> `npm audit --omit=dev` first — the advisories may already be resolved; if
> the audit is clean, mark this plan DONE without further changes.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW-MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `9302177`, 2026-07-03

## Why this matters

`npm audit --omit=dev` reports 8 advisories (3 high) in the production
dependency tree, all transitive under `@tobilu/qmd@2.5.3`: `simple-git`
(high, RCE) via `node-llama-cpp → cmake-js`, `hono` and `fast-uri` (high)
via `@modelcontextprotocol/sdk`, plus 5 moderates (`tar`, `qs`, etc.).
Reachability from zotagent's runtime is doubtful — these sit under qmd's
MCP-server and llama.cpp build subtrees, which zotagent's `openQmdClient`
path does not appear to invoke — but the fixes are available within existing
semver ranges, so clearing them is cheap and keeps `npm install` output and
future audits clean.

## Current state

- `package.json` dependencies include `"@tobilu/qmd": "^2.1.0"` (installed:
  `2.5.3`). The advisory chain (from `npm ls simple-git qs tar --omit=dev`):

  ```
  zotagent@0.38.0
  └─┬ @tobilu/qmd@2.5.3
    ├─┬ @modelcontextprotocol/sdk@1.29.0 → express → qs (+ hono, fast-uri per audit)
    └─┬ node-llama-cpp@3.18.1
      ├─┬ cmake-js@8.0.0 → tar
      └── simple-git@3.33.0
  ```

- `npm audit --omit=dev` (2026-07-03) ends with:
  `8 vulnerabilities (5 moderate, 3 high)` and states
  `fix available via npm audit fix` for each — i.e. compatible (non-breaking)
  version bumps inside the lockfile suffice; no `--force` needed.

- zotagent consumes qmd only through `src/qmd.ts` (createStore/search/embed);
  the semantic-search test coverage lives in `tests/unit/qmd.test.ts` and
  `tests/unit/qmd-fts-migration.test.ts`.

## Commands you will need

| Purpose      | Command                  | Expected on success                     |
|--------------|--------------------------|-----------------------------------------|
| Install      | `npm ci`                 | exit 0                                   |
| Fix          | `npm audit fix`          | exit 0, lockfile updated, no `--force` prompt acted on |
| Re-audit     | `npm audit --omit=dev`   | 0 high/critical (0 total expected)       |
| Full gate    | `npm run check`          | exit 0                                   |

## Scope

**In scope** (the only files you should modify):
- `package-lock.json`

**Out of scope** (do NOT touch):
- `package.json` — `npm audit fix` without `--force` must not change declared
  ranges; if it does, that is a STOP condition.
- Any source file.
- `npm audit fix --force` — never. It can jump `@tobilu/qmd` majors.

## Git workflow

- Branch: `advisor/007-transitive-dependency-advisories`
- Single commit; message style matches repo history, e.g.
  `deps: npm audit fix for transitive advisories under @tobilu/qmd`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Apply the compatible fixes

Run `npm audit fix` (no flags). Then check what changed:
`git diff --stat` must show `package-lock.json` only.

**Verify**: `npm audit --omit=dev` → reports 0 high and 0 critical
advisories. (If moderates remain that have no compatible fix, record the
exact residual list in your report — that is acceptable; high/critical
remaining is not.)

### Step 2: Prove the runtime still works

**Verify**: `npm run check` → exit 0 (274+ tests pass, including the qmd
suites `tests/unit/qmd.test.ts` and `tests/unit/qmd-fts-migration.test.ts`).

## Test plan

No new tests — the change is lockfile-only. The existing qmd unit suites are
the regression net for the bumped subtree.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `git diff --stat` (vs the branch base) shows only `package-lock.json`
- [ ] `npm audit --omit=dev` → 0 high, 0 critical
- [ ] `npm run check` exits 0
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `npm audit fix` modifies `package.json` or asks for `--force` to resolve
  any high advisory — that means a breaking bump is required and the
  maintainer must decide (likely: wait for a `@tobilu/qmd` release).
- `npm run check` fails after the fix — report the failing tests and revert
  nothing; the reviewer decides.
- High/critical advisories remain after a plain `npm audit fix`.

## Maintenance notes

- The underlying exposure is `@tobilu/qmd` bundling an MCP server and
  node-llama-cpp; advisories in that subtree will recur. Consider (separately,
  not in this plan) asking upstream to slim optional deps, or pinning qmd
  more tightly if reproducibility starts to matter.
- Semantic search has no cheap end-to-end test without a real indexed
  library; if the operator has one configured, a manual
  `zotagent search --semantic "<query>"` smoke run after merge is a
  worthwhile extra check (noted for the human, not the executor).
