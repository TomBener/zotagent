// The CLI flag surface, declared once. Everything the argument parser
// needs (boolean-flag set, per-command allowlists, global overrides) is
// derived from COMMAND_FLAGS, and the drift test in
// tests/unit/cli-spec.test.ts checks this table against the help text in
// both directions. Kept free of side effects so tests can import it
// without executing the CLI entry point in cli.ts.

/** One row per command flag. `boolean: true` marks flags that take no value.
 *  Declaration order matters: the rejectUnknownFlags message lists a
 *  command's flags in this order. */
interface FlagSpec {
  name: string;
  boolean?: true;
}

// The single source for every command's flag surface. The boolean-flag set
// and the per-command allowlist are derived below, and a unit test checks
// the help text against this table — adding a flag in one place and
// forgetting the other can no longer drift silently.
export const COMMAND_FLAGS: Record<string, ReadonlyArray<FlagSpec>> = {
  sync: [
    { name: "attachments-root" },
    { name: "retry-errors", boolean: true },
    { name: "pdf-timeout-ms" },
    { name: "pdf-batch-size" },
    { name: "pdf-concurrency" },
  ],
  status: [],
  config: [],
  version: [],
  help: [],
  add: [
    { name: "doi" },
    { name: "s2-paper-id" },
    { name: "from-url" },
    { name: "identifier" },
    { name: "select" },
    { name: "json" },
    { name: "title" },
    { name: "author" },
    { name: "year" },
    { name: "publication" },
    { name: "url" },
    { name: "url-date" },
    { name: "access-date" },
    { name: "collection-key" },
    { name: "item-type" },
    { name: "attach-file" },
  ],
  s2: [{ name: "limit" }],
  recent: [{ name: "limit" }, { name: "sort" }],
  search: [
    { name: "keyword", boolean: true },
    { name: "semantic", boolean: true },
    { name: "limit" },
    { name: "min-score" },
    { name: "tag" },
    { name: "collection-key" },
  ],
  "search-in": [{ name: "key" }, { name: "limit" }],
  metadata: [
    { name: "limit" },
    { name: "field" },
    { name: "has-file", boolean: true },
    { name: "abstract", boolean: true },
    { name: "author" },
    { name: "year" },
    { name: "title" },
    { name: "journal" },
    { name: "publisher" },
    { name: "tag" },
    { name: "collection-key" },
  ],
  blocks: [{ name: "key" }, { name: "offset-block" }, { name: "limit-blocks" }],
  fulltext: [{ name: "key" }, { name: "clean", boolean: true }],
  expand: [{ name: "key" }, { name: "offset" }, { name: "radius" }],
  diagnose: [
    { name: "limit" },
    { name: "all", boolean: true },
    { name: "threshold-avg" },
    { name: "threshold-median" },
  ],
};

/** Booleans every command accepts regardless of its own flag rows. */
const GLOBAL_BOOLEAN_FLAGS: ReadonlyArray<string> = ["help", "version"];

export const BOOLEAN_FLAGS = new Set<string>([
  ...GLOBAL_BOOLEAN_FLAGS,
  ...Object.values(COMMAND_FLAGS).flatMap((specs) =>
    specs.filter((spec) => spec.boolean).map((spec) => spec.name),
  ),
]);

// Every known command accepts exactly its declared flags plus the global
// config overrides. Anything else triggers UNEXPECTED_ARGUMENT rather than
// being silently ignored.
export const COMMAND_FLAG_ALLOWLIST: Record<string, ReadonlyArray<string>> = Object.fromEntries(
  Object.entries(COMMAND_FLAGS).map(([command, specs]) => [
    command,
    specs.map((spec) => spec.name),
  ]),
);

export const GLOBAL_OVERRIDE_FLAGS: ReadonlyArray<string> = [
  "bibliography",
  "bibliography-json",
  "attachments-root",
  "data-dir",
  "qmd-embed-model",
  "semantic-scholar-api-key",
  "zotero-library-id",
  "zotero-library-type",
  "zotero-collection-key",
  "zotero-api-key",
  "translation-server-url",
  "embedding-provider",
  "embedding-model",
  "google-api-key",
];

export function helpText(): string {
  return `zotagent — Zotero CLI for AI agents.

Usage: zotagent <command> [flags]

All commands emit pretty-printed JSON on stdout. Success payloads are
{ok: true, data, meta?}; failures are {ok: false, error: {code, message, details?}}
with exit code 1. Missing credentials fail fast with a JSON error. sync includes
meta.elapsedMs because it can be long-running.
Local search payloads (search, search-in, metadata) include data.query once
alongside data.results.

Index
  sync [--attachments-root <path>] [--retry-errors] [--pdf-timeout-ms <n>] [--pdf-batch-size <n>]
       [--pdf-concurrency <n>]
      Build or refresh the local index of PDF, EPUB, HTML, and TXT attachments.
      Unchanged extraction errors are skipped by default; pass --retry-errors to retry them.
        --attachments-root <path>   Index only a Zotero subfolder.
        --retry-errors              Retry unchanged files that failed extraction earlier.
        --pdf-timeout-ms <n>        Override the OpenDataLoader timeout for each PDF extraction call.
        --pdf-batch-size <n>        Override the maximum number of PDFs per extraction batch.
        --pdf-concurrency <n>       Run N extraction batches in parallel (default 2). Each batch
                                    spawns its own java process; tune with available CPU and RAM.
      Recognizes two Zotero tags by default (names customizable via
      \`excludeTag\` / \`verticalTextTag\` in ~/.zotagent/config.json):
        - \`zotagent:exclude\`: items skipped entirely (no extraction, no manifest,
          no keyword/qmd indexing). Use \`zotagent diagnose\` to find candidates.
        - \`zotagent:vertical\`: items extracted with --reading-order=off so
          vertical CJK columns don't get scrambled by xycut block ordering.
      Both tags are silently ignored if Zotero API credentials aren't configured.

  status
      Show attachment counts, local index paths, and qmd status.

  version, --version            Print the current zotagent version.
  help, --help                  Show this help. Also shown when no command is given.

  config
      Interactively set ~/.zotagent/config.json.

Search
  search "<text>" [--keyword | --semantic] [--limit <n>] [--min-score <n>] [--tag <tag>] [--collection-key <key>]
      Search indexed documents. Pass at most one of --keyword (default) or --semantic.
      Default is keyword search (FTS5 with porter stemming): "exact phrase", OR, NOT,
      term NEAR/<n> term, prefix*. Use NEAR/50 for proximity; NEAR(...) is not accepted.
      Chinese, Japanese, and Korean text is supported with accurate phrase matching.
      --semantic uses qmd vector search with LLM query expansion (slower, heavier).
        --limit <n>                 Return up to n search results. Default: 10 for search, 20 for metadata.
        --min-score <n>             Drop lower-scoring search hits before mapping.
        --tag <tag>                 Restrict keyword search to top-level Zotero items with this tag.
                                    Repeatable; requires Zotero read API config.
        --collection-key <key>      Restrict keyword search to top-level items directly in this Zotero
                                    collection. Repeatable (union); combinable with --tag (intersection);
                                    requires Zotero read API config.

  search-in "<text>" --key <key> [--limit <n>]
      Search within one indexed item's attachments. Uses the same FTS5 keyword
      syntax as search: "exact phrase", OR, NOT, term NEAR/<n> term, prefix*.
      Requires a populated keyword index (run zotagent sync first).

  metadata ["<text>"] [--limit <n>] [--field <field>] [--has-file] [--abstract]
           [--author <text>] [--year <text>] [--title <text>] [--journal <text>] [--publisher <text>]
           [--tag <tag>] [--collection-key <key>]
      Search Zotero bibliography metadata read from bibliographyJsonPath.
      Provide a positional query, one or more field filters, or both. The
      positional query is substring-matched across --field selections; each
      filter flag adds an AND constraint on that specific field. --tag and
      --collection-key fetch matching top-level item keys from the Zotero Web
      API, then filter locally.
        --field <field>             Limit the positional query to title, author, year, abstract,
                                    journal, or publisher. Repeatable.
        --author <text>             Filter by author substring.
        --year <text>               Filter by year substring (e.g. "1985", "198" for the 80s).
        --title <text>              Filter by title substring.
        --journal <text>            Filter by journal substring.
        --publisher <text>          Filter by publisher substring.
        --tag <tag>                 Filter by top-level Zotero item tag. Repeatable; requires
                                    Zotero read API config.
        --collection-key <key>      Filter by top-level items directly in this Zotero collection.
                                    Repeatable (union); combinable with --tag (intersection);
                                    requires Zotero read API config.
        --has-file                  Keep only metadata results with a supported indexed attachment.
        --abstract                  Include the abstract in each result. Omitted by default to keep
                                    bulk responses compact for agents.

Retrieval
  blocks --key <key> [--offset-block <n>] [--limit-blocks <n>]
      Return paginated blocks from one indexed item.
      When one item has multiple indexed attachments, they are merged into one logical
      document with monotonic block indices and "# Attachment: <name>" dividers between them.
        --offset-block <n>          Start at block n. Default: 0.
        --limit-blocks <n>          Return up to n blocks. Default: 20.

  fulltext --key <key> [--clean]
      Output agent-friendly full text for one item. Multi-attachment items return one
      merged markdown document.
        --clean                     Apply heuristic cleanup (drops duplicate blocks and
                                    common boilerplate such as citation notices and TOC lines).

  expand --key <key> --offset <n> [--radius <n>]
      Return a continuous slice of the rendered markdown around a search-result
      \`charOffset\`. Useful when a search passage feels truncated and you want
      more context around the hit.
        --offset <n>                Char offset to center on. Pass \`charOffset\` from a search result.
        --radius <n>                Half-window in characters. Default: 1000 (i.e. ~2000 char window).

Diagnostics
  diagnose [--limit <n>] [--all] [--threshold-avg <n>] [--threshold-median <n>]
      Scan all indexed manifests and surface documents whose extracted blocks
      look anomalously short — usually an upstream extraction failure (per-word
      English, per-character vertical CJK, scanned non-OCR PDFs, multi-column
      gazetteers). Output identifies the affected itemKeys so you can re-extract
      those PDFs (e.g. ocrmypdf, pdftotext -layout) and re-sync.
        --limit <n>                 Cap the result list. Default: 50.
        --all                       Include "ok" docs too. Default: only suspicious + borderline.
        --threshold-avg <n>         Suspicious avg-chars-per-block threshold. Default: 15.
        --threshold-median <n>      Suspicious median-chars-per-block threshold. Default: 10.

Document selector (used by search-in, blocks, fulltext, expand)
  --key <key>                   Resolve an item by itemKey or citationKey. A leading @ is
                                stripped before dispatch; values matching [A-Z0-9]{8} are
                                itemKey, anything else is citationKey. Output always
                                identifies items by itemKey only.

Add to Zotero
  add [--doi <doi> | --s2-paper-id <id> | --from-url <url> | --identifier <id> | --json <file|->]
      [--select <key>] [--title <text>] [--author <name>]
      [--year <text>] [--publication <text>] [--url <url>] [--url-date <date>]
      [--collection-key <key>] [--item-type <type>] [--attach-file <path>]
      Create one or many Zotero items and return their itemKeys. Prefer --doi when available.
      --s2-paper-id imports from Semantic Scholar (and still prefers DOI when present).
      --from-url and --identifier run Zotero's site translators through a configured
      translation-server (translationServerUrl) — the same metadata extraction the Zotero
      browser connector does, including publisher keywords as tags and translator notes as
      child notes (attachments are not saved; use --attach-file for a downloaded file).
      When translationServerUrl is set, --doi also resolves through it for richer
      metadata; otherwise --doi uses doi.org CSL JSON.
      --json reads pre-shaped JSON metadata from a file or stdin and is best for batch
      ingest from sources without working DOIs (e.g. CNKI). The JSON form is mutually
      exclusive with all other input flags except --collection-key.
        --doi <doi>                 Import from DOI metadata when possible.
        --s2-paper-id <id>          Import a Semantic Scholar paper by paperId.
        --from-url <url>            Translate a web page into an item via translation-server.
                                    If the page lists multiple candidates, add fails with
                                    MULTIPLE_RESULTS and details.choices; re-run with
                                    --select <key> to import one of them.
        --identifier <id>           Import by DOI, ISBN, PMID, or arXiv ID via
                                    translation-server (Zotero's "magic wand").
        --select <key>              Pick one candidate from a MULTIPLE_RESULTS response.
                                    Only valid with --from-url.
        --json <file|->             Read one JSON object or an array of JSON objects from
                                    a file or stdin (use '-'). Lenient Zotero schema:
                                    accepts authors[]/keywords[]/abstract/doi aliases plus
                                    direct Zotero field names. Always returns data: AddResult[].
                                    Per-item attachFile / attach-file field attaches a local
                                    file as a linked_file child (see --attach-file).
        --title <text>              Set title for manual add or DOI fallback.
        --author <name>             Add an author. Repeat for multiple authors.
        --year <text>               Set the Zotero date field.
        --publication <text>        Set journal, website, or container title when supported.
        --url <url>                 Set the item URL.
        --url-date <date>           Set the access date for the URL. Alias: --access-date.
        --collection-key <key>      Add the new item(s) to a Zotero collection by collection key.
                                    With --json this overrides any per-item collections field.
        --item-type <type>          Override the Zotero item type. Default: journalArticle or webpage.
        --attach-file <path>        Attach a local file to the new item as a linkMode=linked_file
                                    child (file stays on disk, no Zotero storage quota used). When
                                    the path is under the configured attachmentsRoot, zotagent
                                    stores it as 'attachments:<rel>' for cross-device portability;
                                    otherwise as an absolute path. Mutually exclusive with --json
                                    (use the per-item attachFile field there). Path is validated
                                    before the parent item is created, so a bad path can't leave
                                    an orphan in Zotero. AddResult exposes attachmentItemKey on
                                    success.

  s2 "<text>" [--limit <n>]
      Search Semantic Scholar; pass a returned paperId to \`add --s2-paper-id\`.

  recent [--limit <n>] [--sort added|modified]
      List regular top-level Zotero items most recently added or modified.
      Fetches live from the Zotero Web API; does not require a sync. Skips
      standalone notes and attachments. Returns itemKey plus title, authors,
      year, type, dateAdded, and dateModified.
        --limit <n>                 Return up to n items. Default: 10. Max: 100.
        --sort added|modified       Sort by dateAdded (default) or dateModified.
`;
}
