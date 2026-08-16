# Zotero API — direct access

For what `zotagent` doesn't cover: one item's complete field set, collection and tag discovery, and every kind of edit.

## Reach for the CLI first

| Need | Use |
|---|---|
| Full-text or metadata search, passages, citations, creating items | `zotagent` commands — see SKILL.md |
| One item's complete editable JSON (DOI, volume, pages, URL, tags, collections, dates) | `GET $ZLIB/items/<key>` |
| Collection keys and names, the library's tag list | `GET $ZLIB/collections`, `GET $ZLIB/tags` |
| Any edit: fields, tags, collections, notes, trashing | The recipes below |

The API is the escape hatch, not a second search engine. `zotagent search` and `zotagent metadata` read a local index built for this library — pulling items through the API to search them yourself is slower, rate-limited, and skips the CJK folding and passage extraction the index provides.

## Prelude

Shell state doesn't survive between tool calls. Start every block with this:

```bash
cfg=~/.zotagent/config.json
ZKEY=${ZOTAGENT_ZOTERO_API_KEY:-${ZOTERO_API_KEY:-$(jq -r .zoteroApiKey "$cfg")}}
ZID=${ZOTAGENT_ZOTERO_LIBRARY_ID:-${ZOTERO_LIBRARY_ID:-$(jq -r .zoteroLibraryId "$cfg")}}
ZTYPE=${ZOTAGENT_ZOTERO_LIBRARY_TYPE:-${ZOTERO_LIBRARY_TYPE:-$(jq -r .zoteroLibraryType "$cfg")}}
ZLIB="https://api.zotero.org/$([ "$ZTYPE" = group ] && echo groups || echo users)/$ZID"
zot()  { curl -sS -H "Zotero-API-Key: $ZKEY" -H "Zotero-API-Version: 3" "$@"; }
zotw() { zot -H "Content-Type: application/json" -w '\n%{http_code}\n' "$@"; }
```

Keep the key out of every byte you emit. The shell expands `$ZKEY` into the header, so the command itself stays safe to print — keep it that way: no `echo "$ZKEY"`, no `curl -v` (it prints request headers), no `key=` query parameter, no copying the key into a script or JSON body. Debug a failing request by re-checking the URL and the JSON, never by printing the header.

## Reads

```bash
zot "$ZLIB/items/$ITEM"                    # one item; editable fields are in .data
zot "$ZLIB/items/$ITEM/children"           # child notes and attachments
zot "$ZLIB/items?itemKey=K1,K2,K3"         # up to 50 items in one request
zot "$ZLIB/collections"                    # key, name, parentCollection for each
zot "$ZLIB/collections/$COLL/items/top"
zot "$ZLIB/tags"                           # every tag in the library
zot "$ZLIB/items/$ITEM/tags"
zot "$ZLIB/items/top?sort=dateModified&direction=desc&limit=10"
```

Useful parameters: `format=keys` (newline-separated keys, never paginated), `format=csljson|bibtex|ris` (export), `itemType=book || journalArticle`, `tag=foo&tag=bar` (AND) / `tag=-foo` (NOT), `q=` with `qmode=everything`, `includeTrashed=1`, `since=<version>`.

`limit` caps at 100. When the `Total-Results` header exceeds what you received, walk `start` or follow the `Link` header's `rel="next"` URL.

Stay at 4 concurrent requests or fewer. Honor `Backoff: <seconds>` on any response and `Retry-After` on `429` / `503`.

## Edits: read, modify, write

Every edit fetches the item, changes the JSON, and sends it back with the version it just read. The version is the precondition that stops you from overwriting a change you never saw.

```bash
item=$(zot "$ZLIB/items/$ITEM")
ver=$(jq -r .version <<<"$item")
body=$(jq -c '{DOI: "10.1111/dech.70058", volume: "56"}' <<<"$item")
zotw -X PATCH -H "If-Unmodified-Since-Version: $ver" -d "$body" "$ZLIB/items/$ITEM"
```

`204` means it worked. On `412` the item changed underneath you — re-fetch and redo the edit on the fresh copy, once. A second `412` means something else is writing to the library (a sync in progress); stop and tell the user.

Four rules decide whether an edit is safe:

1. **PATCH, not PUT.** PATCH touches only the properties you send. PUT replaces the whole item: every field you omit is erased, and an omitted `deleted` even pulls the item back out of the trash.
2. **Arrays replace, they don't append.** `tags`, `collections`, and `creators` are complete lists. Adding one tag means sending the existing tags *plus* the new one — send only the new one and the rest are gone. Build the array with `jq` from the copy you just fetched, as the recipes below do.
3. **Send fields the item type actually has.** `curl -s "https://api.zotero.org/items/new?itemType=book"` returns the empty template for a type; anything outside it comes back `400` with the reason (`'issue' is not a valid field for type 'book'`). Changing `itemType` on an existing item drops the fields the new type lacks.
4. **Mark your edits.** Add the tag `Edited by Zotagent` in the same PATCH, matching the `Added by Zotagent` tag that `zotagent add` writes. It is the only trace of what an agent touched.

## Recipes

Add a tag, keeping the existing ones:

```bash
item=$(zot "$ZLIB/items/$ITEM"); ver=$(jq -r .version <<<"$item")
body=$(jq -c '{tags: ([.data.tags[], {tag:"To Read"}, {tag:"Edited by Zotagent"}] | unique_by(.tag))}' <<<"$item")
zotw -X PATCH -H "If-Unmodified-Since-Version: $ver" -d "$body" "$ZLIB/items/$ITEM"
```

Remove a tag — same shape, different `jq`:

```bash
body=$(jq -c '{tags: [.data.tags[] | select(.tag != "To Read")]}' <<<"$item")
```

File into a collection (get the key from `GET $ZLIB/collections`):

```bash
body=$(jq -c '{collections: (.data.collections + ["ABCD1234"] | unique)}' <<<"$item")
```

Attach a child note. The body is HTML, and notes are created, not patched:

```bash
zotw -X POST -d '[{"itemType":"note","parentItem":"'"$ITEM"'","note":"<p>Summary…</p>","tags":[{"tag":"Edited by Zotagent"}]}]' "$ZLIB/items"
```

Batch up to 50 items: POST an array to `$ZLIB/items` with each object carrying its own `key` and `version`. POST follows PATCH semantics — omitted properties are left alone.

Multi-object writes return `200` even when individual objects fail. Read the response's `successful` / `unchanged` / `failed` maps, keyed by array index, before reporting success.

## Deleting

Ask the user before any of these, quoting the exact items you are about to remove.

- **Trash — reversible, prefer it.** `PATCH {"deleted": true}` with the version precondition, exactly like any other edit. It must be a JSON boolean; `false` restores the item.
- **Permanent delete.** `zot -X DELETE -H "If-Unmodified-Since-Version: $ver" "$ZLIB/items/$ITEM"` → `204`. A `428` means the header is missing. There is no undo, and the deletion propagates to every synced device.
- Up to 50 at once: `DELETE $ZLIB/items?itemKey=K1,K2` with the *library* version.

## An API write does not reach the index

Editing through the API changes Zotero, not zotagent's local view. `zotagent metadata` keeps reporting the old values until `bibliographyJsonPath` is re-exported, and the full-text index is untouched. Confirm a write landed by re-fetching the item, or with `zotagent recent --sort modified` — not with `zotagent metadata`.

## Local API — faster reads, no key

When Zotero is running with Settings → Advanced → "Allow other applications on this computer to communicate with Zotero" enabled, the same read endpoints are served from the local database at `http://localhost:23119/api/users/0/…`: no API key, no rate limit, no pagination cap, works offline. `403` means the preference is off; a connection failure means Zotero isn't running. Fall back to the Web API either way.

Versions from the local API are local (Zotero 10+) and unrelated to Web API versions. Take the version for a write from the same API you write to — a local version used as a Web API precondition is meaningless.

## Official documentation

- Reads, parameters, rate limits: <https://www.zotero.org/support/dev/web_api/v3/basics>
- Writes, batching, status codes: <https://www.zotero.org/support/dev/web_api/v3/write_requests>
- Item types, fields, templates: <https://www.zotero.org/support/dev/web_api/v3/types_and_fields>
- Local API: <https://www.zotero.org/support/dev/web_api/v3/local_api>
