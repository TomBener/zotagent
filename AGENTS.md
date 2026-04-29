# zotagent Notes

`zotagent` is a Zotero CLI for AI agents.

## Core invariants

- `dataDir` is `~/Zotagent` — holds long-lived indexes (`index/`, `manifests/`, `normalized/`, `logs/`).
- Config lives in `~/.zotagent` — `config.json` and `excludes.txt`.

## Development Principles

- Avoid unnecessary fallbacks or compatibility layers. When you change CLI or config behavior, switch cleanly and update help text, tests, and docs in the same change.
- Validate search changes on a real indexed subset, not just unit tests.
- To exercise local changes, run `node dist/cli.js <cmd>` after `npm run build` (or `npm run dev -- <cmd>`). Never test against the globally-installed `zotagent` — it executes the previously-installed build and will silently run stale code.

## Release Process

1. bump `package.json` and `package-lock.json`
2. `npm run check`
3. commit the release prep
4. `git tag -a vX.Y.Z -m "vX.Y.Z"` and `git push origin main && git push origin vX.Y.Z`
5. after the release workflow finishes, write the final changelog on the GitHub release with `gh release edit`
