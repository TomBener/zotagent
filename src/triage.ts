import type { CatalogEntry } from "./types.js";

// The triage decision table: given plain facts about one attachment, decide
// what a sync run does with it. Pure — no filesystem, no store, no Zotero.
// The sync loop gathers the facts (stat, reuse verdict, probe, rename-index
// lookup) and acts on the returned decision; every lifecycle transition an
// attachment can take lives here, testable as a table.

export interface TriageFacts {
  /** Bibliography says the file type is extractable. */
  supported: boolean;
  /** The source file is present on disk right now. */
  fileExists: boolean;
  isPdf: boolean;
  /** extractStatus of the previous catalog entry; undefined = never seen. */
  previousStatus: CatalogEntry["extractStatus"] | undefined;
  /** A previous entry exists and still describes the file on disk: its
   *  recorded size/mtime match, or they do not but the file's sha1 equals the
   *  recorded sourceHash. Hashing is sync.ts's business — an iCloud/Dropbox
   *  re-download rewrites mtime without touching a byte, and only a hash can
   *  tell that apart from an in-place edit. */
  sourceUnchanged: boolean;
  /** The store's full reuse verdict (identity + blocks + vertical for PDFs). */
  artifactsReusable: boolean;
  /** Cheap probe: both artifact halves present, normalized non-empty. */
  artifactPairPresent: boolean;
  /** The previous sync reached its completion marker. */
  previousCatalogCompleted: boolean;
  /** --retry-errors: re-extract attachments with unchanged previous errors. */
  retryErrors: boolean;
  /** The rename index has a unique (itemKey,size,mtime) candidate. */
  hasRenameCandidate: boolean;
}

export type TriageDecision =
  | { action: "record-unsupported" }
  | { action: "record-missing" }
  /** Carry the previous error entry forward; do not re-extract. */
  | { action: "skip-unchanged-error" }
  /** Attempt rename adoption; on any refusal or failure, extract. */
  | { action: "adopt-then-extract" }
  /** Reuse the on-disk artifact. carryPreviousIndexState says whether the
   *  previous entry's sourceHash/lastIndexedAt still describe it (ready and
   *  unchanged) or whether this is a recovery reuse (catalog lost or
   *  previous status missing/error) that must re-earn lastIndexedAt. Whether
   *  a sourceHash can be recorded for a recovery reuse is sync.ts's call. */
  | { action: "reuse"; carryPreviousIndexState: boolean }
  | { action: "extract" };

// Are the cached artifacts good enough to reuse? For PDFs the manifest's
// recorded extraction mode must match the current vertical-text tag verdict —
// that's the source of truth for "does this cached artifact match what the
// user wants now?", so the full verdict is required. Non-PDF entries can use
// the cheap existence probe once a previous sync completed. Exported because
// sync.ts gates its (expensive) hash computation on the same rule: hashing is
// pointless where the artifacts would be rejected anyway.
export function artifactsAcceptable(
  facts: Pick<
    TriageFacts,
    "isPdf" | "previousCatalogCompleted" | "artifactsReusable" | "artifactPairPresent"
  >,
): boolean {
  return facts.previousCatalogCompleted && !facts.isPdf
    ? facts.artifactPairPresent
    : facts.artifactsReusable;
}

export function decideTriage(facts: TriageFacts): TriageDecision {
  if (!facts.supported) return { action: "record-unsupported" };
  if (!facts.fileExists) return { action: "record-missing" };

  const previousReadyAndUnchanged =
    facts.previousStatus === "ready" && facts.sourceUnchanged && artifactsAcceptable(facts);

  // An error entry never carries a sourceHash, so for it sourceUnchanged is
  // exactly the stat comparison.
  if (
    facts.previousStatus === "error" &&
    facts.sourceUnchanged &&
    !facts.artifactsReusable &&
    !facts.retryErrors
  ) {
    return { action: "skip-unchanged-error" };
  }

  // Rename fast path: an attachment never seen under this docKey, with no
  // reusable artifacts of its own, whose (itemKey,size,mtime) matches a
  // previous ready entry that dropped out of the bibliography — adopt that
  // entry's artifacts instead of re-extracting and re-embedding.
  if (facts.previousStatus === undefined && !facts.artifactsReusable && facts.hasRenameCandidate) {
    return { action: "adopt-then-extract" };
  }

  // If the previous record says ready but the source changed, on-disk
  // artifacts matching the docKey are stale — produced before the change
  // (seen in practice after a user re-OCRs a scanned PDF in place).
  // Reusable-looking artifacts are only a recovery hint when there is no
  // reliable prior state to compare against.
  const previousWasReadyButChanged =
    facts.previousStatus === "ready" && !facts.sourceUnchanged;
  if (!previousReadyAndUnchanged && (previousWasReadyButChanged || !facts.artifactsReusable)) {
    return { action: "extract" };
  }

  return { action: "reuse", carryPreviousIndexState: previousReadyAndUnchanged };
}
