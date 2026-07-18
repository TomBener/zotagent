// The index-invalidation policy: pure decisions about what a sync run must
// do to the keyword and semantic indexes, given how the indexer state changed
// since the last completed sync. sync.ts computes the facts; every verdict —
// rebuild vs incremental update, clear embeddings vs preserve them,
// short-circuit vs run the index phase — lives here, testable as a table.

/** The indexer-state markers persisted on a completed catalog. */
export interface IndexerState {
  indexedQmdEmbedModel: string;
  indexerSignature: string;
}

export interface PreviousIndexFacts {
  indexedQmdEmbedModel: string | undefined;
  indexerSignature: string | undefined;
  /** The previous catalog had ready entries, so qmd may hold their vectors. */
  hadReadyEntries: boolean;
}

export interface IndexerComparison {
  current: IndexerState;
  qmdEmbedModelChanged: boolean;
  indexerSignatureChanged: boolean;
  /**
   * Clearing all qmd embeddings is an expensive, destructive operation: it
   * wipes every stored vector and forces the entire library to be re-embedded
   * from scratch. Only trigger it when the embedding model itself changes,
   * which is the one situation where existing vectors become semantically
   * incompatible — and only when stored vectors may actually exist. Other
   * signature changes (keyword schema bumps, qmd package upgrades) still
   * break the short-circuit so indexes are refreshed, but stored embeddings
   * are preserved.
   */
  qmdResetNeeded: boolean;
  /**
   * The indexer state progress writes should record. While a reset is
   * pending, keep the previous state (or none) so a crash before the clear
   * cannot masquerade as a completed migration; once embeddings are cleared,
   * the caller advances to `current`.
   */
  progressIndexerState: IndexerState | undefined;
}

export function compareIndexerState(
  current: IndexerState,
  previous: PreviousIndexFacts,
): IndexerComparison {
  const previousState: IndexerState | undefined =
    previous.indexedQmdEmbedModel && previous.indexerSignature
      ? {
          indexedQmdEmbedModel: previous.indexedQmdEmbedModel,
          indexerSignature: previous.indexerSignature,
        }
      : undefined;
  const qmdEmbedModelChanged = previous.indexedQmdEmbedModel !== current.indexedQmdEmbedModel;
  const indexerSignatureChanged = previous.indexerSignature !== current.indexerSignature;
  const mayContainExistingEmbeddings = previous.hadReadyEntries || previousState !== undefined;
  const qmdResetNeeded = qmdEmbedModelChanged && mayContainExistingEmbeddings;
  return {
    current,
    qmdEmbedModelChanged,
    indexerSignatureChanged,
    qmdResetNeeded,
    progressIndexerState: qmdResetNeeded ? previousState : current,
  };
}

export interface IndexUpdateFacts {
  /** The previous catalog carries `indexesCompletedAt` — it is only present
   *  if that run reached the end of the qmd block, so a crash between the
   *  progress-catalog write and qmd completion cannot fake completion. */
  previousCompleted: boolean;
  changedAttachments: number;
  staleDocKeys: number;
  /** Orphans were part of qmd's normalized-dir corpus until this sweep; a
   *  non-zero count forces one index pass so their stale vectors get reaped. */
  orphanDocKeys: number;
  /** Every next-catalog entry content-matches its previous counterpart. */
  allEntriesMatchPrevious: boolean;
}

export interface IndexUpdateDecision {
  /** Nothing changed since the last completed sync: both index passes are
   *  provably no-ops and are skipped entirely. */
  shortCircuit: boolean;
  /** Rebuild the keyword FTS from scratch instead of updating incrementally:
   *  the previous sync never completed, or the indexer implementation
   *  changed out from under the stored rows. */
  keywordRebuild: boolean;
}

export function decideIndexUpdate(
  comparison: IndexerComparison,
  facts: IndexUpdateFacts,
): IndexUpdateDecision {
  const keywordRebuild = !facts.previousCompleted || comparison.indexerSignatureChanged;
  const shortCircuit =
    facts.previousCompleted &&
    !comparison.qmdEmbedModelChanged &&
    !comparison.indexerSignatureChanged &&
    facts.changedAttachments === 0 &&
    facts.staleDocKeys === 0 &&
    facts.orphanDocKeys === 0 &&
    facts.allEntriesMatchPrevious;
  return { shortCircuit, keywordRebuild };
}
