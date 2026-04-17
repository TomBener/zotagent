# zotagent Notes

`zotagent` is a Zotero CLI for AI agents.

## Core invariants

- `itemKey` (Zotero item key) is the primary identifier. `citationKey` is a mutable display field only.
- `docKey = sha1(filePath)`, so renaming or moving an attachment looks like "old path removed + new path added".
- `add` is speed-first and does not do Zotero-side duplicate checking; write responses should return `itemKey` immediately.
- `read` and `expand` read local manifests directly; they do not depend on the search backend.
- Long-lived indexes live in the iCloud-backed `dataDir`. Do not move persistent index files into `/tmp`.

## Local Environment

- Java is only needed for `sync` (PDF extraction via OpenDataLoader). OpenJDK is installed via Homebrew but not on the default PATH. Prepend before running `sync`: `export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"`

## Development Principles

- Avoid unnecessary fallbacks or compatibility layers. When you change CLI or config behavior, switch cleanly and update help text, tests, and docs in the same change.
- Validate search changes on a real indexed subset, not just unit tests. Check: top result is sensible; no single document dominates the first few slots; reference-only hits do not leak upward; `passage` is not polluted by title-page or front-matter text; `read` and `expand` still behave correctly.

## Release Process

1. bump `package.json` and `package-lock.json`
2. `npm run check`
3. commit the release prep
4. `git tag -a vX.Y.Z -m "vX.Y.Z"` and `git push origin main && git push origin vX.Y.Z`
5. after the release workflow finishes, write the final changelog on the GitHub release with `gh release edit`
