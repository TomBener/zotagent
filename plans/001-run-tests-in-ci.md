# Plan 001: Run the full test suite in CI on every push and PR

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9b80ba6..HEAD -- .github/workflows/ package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `9b80ba6`, 2026-07-03

## Why this matters

The repo has a strong test suite (~19 unit test files including a 5000-line
`sync.test.ts`, plus `tests/integration/cli.test.ts`), but the only workflow
that runs on pushes and pull requests executes typecheck only. Tests run in CI
solely at release-tag time (`release.yml`), which means a behavioral regression
in heavily-churned files like `src/sync.ts` merges green to `main` and is only
caught when cutting a release — after it has already landed. Wiring the
existing one-command verification (`npm run check`) into the push/PR workflow
closes this gap with no new infrastructure.

## Current state

- `.github/workflows/lint.yml` — the only push/PR workflow. Its last step is:

  ```yaml
  # .github/workflows/lint.yml:24-28
      - name: Install dependencies
        run: npm ci

      - name: Run lint
        run: npm run lint
  ```

  It sets up Node 24 with npm cache but does NOT set up Java.

- `.github/workflows/release.yml` — proves `npm run check` works in GitHub
  Actions. Note it sets up Java before running checks (some sync paths shell
  out to a Java-based PDF extractor):

  ```yaml
  # .github/workflows/release.yml:26-33, 52-53
      - name: Set up Java
        uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: "21"

      - name: Install dependencies
        run: npm ci
  ...
      - name: Run checks
        run: npm run check
  ```

- `package.json` scripts: `"lint": "tsc --noEmit"`, `"test": "tsx --test
  tests/**/*.test.ts"`, `"check": "npm run lint && npm test"`.

- Repo convention (AGENTS.md "Development Principles"): "When you change CLI
  or config behavior, switch cleanly and update help text, tests, and docs in
  the same change." Applied here: replace the lint-only workflow with a full
  check workflow rather than layering a second workflow beside it.

## Commands you will need

| Purpose   | Command          | Expected on success |
|-----------|------------------|---------------------|
| Install   | `npm ci`         | exit 0              |
| Typecheck | `npm run lint`   | exit 0, no errors   |
| Tests     | `npm test`       | all pass            |
| Full gate | `npm run check`  | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `.github/workflows/lint.yml` → renamed to `.github/workflows/ci.yml`

**Out of scope** (do NOT touch, even though they look related):
- `.github/workflows/release.yml` — already runs `npm run check`; leave as is.
- `package.json` scripts — `check` already exists; do not add new scripts.
- Any test file — this plan changes CI wiring only.

## Git workflow

- Branch: `advisor/001-run-tests-in-ci`
- Single commit; message style matches repo history (short imperative, e.g.
  `ci: run the full test suite on push and pull_request`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Rename the workflow and run the full check

`git mv .github/workflows/lint.yml .github/workflows/ci.yml`, then edit
`ci.yml` so it reads:

```yaml
name: CI

on:
  push:
    branches:
      - main
  pull_request:
  workflow_dispatch:

jobs:
  check:
    runs-on: ubuntu-latest

    steps:
      - name: Check out repository
        uses: actions/checkout@v6

      - name: Set up Node.js
        uses: actions/setup-node@v6
        with:
          node-version: "24"
          cache: npm

      - name: Set up Java
        uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: "21"

      - name: Install dependencies
        run: npm ci

      - name: Run checks
        run: npm run check
```

The Java step mirrors `release.yml:26-30` — release CI deliberately installs
Java before `npm run check`, so keep it here for parity.

**Verify**: `ls .github/workflows/` → shows `ci.yml` and `release.yml`, no
`lint.yml`.

### Step 2: Prove the gate passes locally

Run the exact command CI will run.

**Verify**: `npm ci && npm run check` → exit 0, typecheck clean, all tests
pass. (Tests take ~40s; that is normal.)

### Step 3: Check for branch protection referencing the old job name

If the `gh` CLI is available and authenticated:

`gh api repos/{owner}/{repo}/branches/main/protection --jq '.required_status_checks.contexts' 2>&1`

- If the response is a 404 ("Branch not protected"), nothing to do.
- If it lists a context containing `Lint` or `lint`, report this in your
  completion notes: the repo owner must update the required status check to
  the new `CI / check` job name after merging. Do not attempt to modify
  branch protection yourself.

**Verify**: command ran; outcome recorded in your completion notes.

## Test plan

No new test files — the deliverable is CI wiring. Verification is Step 2
(local `npm run check` green) plus, after the change is pushed by the
operator, a green `CI` workflow run on GitHub.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `.github/workflows/ci.yml` exists; `.github/workflows/lint.yml` does not
- [ ] `grep -n "npm run check" .github/workflows/ci.yml` → one match
- [ ] `grep -n "pull_request" .github/workflows/ci.yml` → one match
- [ ] `npm run check` exits 0 locally
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `npm run check` fails locally on an unmodified checkout — the baseline is
  broken and must be fixed before gating CI on it.
- The current `lint.yml` content does not match the excerpt above.
- Any test fails only under CI-like conditions you cannot reproduce (report
  the failing test name instead of skipping or deleting it).

## Maintenance notes

- If tests ever grow slow enough to hurt PR feedback, split `test:unit` /
  `test:integration` and gate PRs on unit only (see finding DX-02 in
  `plans/README.md` — deferred).
- Reviewer should confirm the workflow triggers on both `push` to main and
  `pull_request`, and that the release workflow was not touched.
