# zotagent Notes

`zotagent` is a Zotero CLI for AI agents.

## Core invariants

- `dataDir` is `~/Zotagent` — holds long-lived indexes (`index/`, `manifests/`, `normalized/`, `logs/`).
- Config lives in `~/.zotagent` — `config.json`. Sync exclusions come from the Zotero tag `zotagent:exclude` (configurable via `excludeTag`), not a local file.

## Development Principles

- Avoid unnecessary fallbacks or compatibility layers. When you change CLI or config behavior, switch cleanly and update help text, tests, and docs in the same change.
- Validate search changes on a real indexed subset, not just unit tests.
- To exercise local changes, run `node dist/cli.js <cmd>` after `npm run build` (or `npm run dev -- <cmd>`). Never test against the globally-installed `zotagent` — it executes the previously-installed build and will silently run stale code.

## Release Process

Versions are calendar dates: `YYYY.M.D`, the release date without leading zeros (semver requires it — `2026.8.2`, never `2026.08.02`). One release per day; a follow-up fix waits for the next day. Never go back to `0.x`-style numbers — version comparison everywhere (npm, Homebrew) would read it as a downgrade.

1. set the version in `package.json` and `package-lock.json` to today's date
2. `npm run check`
3. commit the release prep
4. `git tag -a vYYYY.M.D -m "vYYYY.M.D"` and `git push origin main && git push origin vYYYY.M.D`
5. after the release workflow finishes, write the final changelog on the GitHub release with `gh release edit`
