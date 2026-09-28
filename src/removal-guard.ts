// The mass-removal guard: a pure decision on whether a sync run may proceed
// given how many previously indexed items the current bibliography no longer
// lists. A sync removes every artifact whose attachment it does not see, so a
// bibliography that briefly exports as `[]`, an attachmentsRoot that resolves
// nothing, or a run re-rooted at a subfolder (docKeys are root-relative)
// would otherwise delete the whole index and force a full re-extract and
// re-embed. The guard runs before anything is touched.
//
// Vanished items are counted by itemKey, not docKey: a renamed or relocated
// file keeps its itemKey (rename adoption carries the artifact over), so only
// items that disappear from the bibliography entirely count. Items dropped by
// the exclusion tag are an intentional removal and never count.

/** Below this many vanished items a run always proceeds: routine deletions
 *  and collection edits between syncs stay well under it. */
export const MASS_REMOVAL_MIN_ITEMS = 50;
/** Above this share of previously indexed items vanishing at once, the run is
 *  refused. A healthy library loses a handful of items between syncs; every
 *  failure this guard exists for loses most or all of them. */
export const MASS_REMOVAL_MAX_FRACTION = 0.1;

export interface RemovalFacts {
  /** itemKeys that have an entry in the previous catalog. */
  previousItemKeys: ReadonlySet<string>;
  /** itemKeys among this run's attachments, after exclusions. */
  currentItemKeys: ReadonlySet<string>;
  /** itemKeys removed on purpose by the exclusion tag. */
  excludedItemKeys: ReadonlySet<string>;
}

export type RemovalDecision =
  | { refuse: false; vanishedItems: number }
  | {
      refuse: true;
      /** "no-attachments": this run resolved no attachments at all.
       *  "mass-removal": a large share of previously indexed items vanished. */
      reason: "no-attachments" | "mass-removal";
      vanishedItems: number;
      previousItems: number;
    };

export function decideRemoval(facts: RemovalFacts): RemovalDecision {
  const previousItems = facts.previousItemKeys.size;
  let vanishedItems = 0;
  for (const itemKey of facts.previousItemKeys) {
    if (!facts.currentItemKeys.has(itemKey) && !facts.excludedItemKeys.has(itemKey)) {
      vanishedItems += 1;
    }
  }
  if (previousItems === 0) return { refuse: false, vanishedItems };
  if (facts.currentItemKeys.size === 0 && vanishedItems > 0) {
    return { refuse: true, reason: "no-attachments", vanishedItems, previousItems };
  }
  if (
    vanishedItems >= MASS_REMOVAL_MIN_ITEMS &&
    vanishedItems > previousItems * MASS_REMOVAL_MAX_FRACTION
  ) {
    return { refuse: true, reason: "mass-removal", vanishedItems, previousItems };
  }
  return { refuse: false, vanishedItems };
}
