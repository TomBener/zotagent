import test from "node:test";
import assert from "node:assert/strict";

import {
  compareIndexerState,
  decideIndexUpdate,
  type IndexerComparison,
  type IndexUpdateFacts,
} from "../../src/index-policy.js";

const CURRENT = { indexedQmdEmbedModel: "model-a", indexerSignature: "sig-1" };

test("identical indexer state: nothing changed, embeddings kept, progress records current", () => {
  const cmp = compareIndexerState(CURRENT, {
    indexedQmdEmbedModel: "model-a",
    indexerSignature: "sig-1",
    hadReadyEntries: true,
  });
  assert.equal(cmp.qmdEmbedModelChanged, false);
  assert.equal(cmp.indexerSignatureChanged, false);
  assert.equal(cmp.qmdResetNeeded, false);
  assert.deepEqual(cmp.progressIndexerState, CURRENT);
});

test("signature-only change (e.g. an opencc upgrade) preserves embeddings", () => {
  const cmp = compareIndexerState(CURRENT, {
    indexedQmdEmbedModel: "model-a",
    indexerSignature: "sig-0",
    hadReadyEntries: true,
  });
  assert.equal(cmp.indexerSignatureChanged, true);
  assert.equal(cmp.qmdEmbedModelChanged, false);
  // The destructive clear is reserved for model changes.
  assert.equal(cmp.qmdResetNeeded, false);
  assert.deepEqual(cmp.progressIndexerState, CURRENT);
});

test("model change with existing vectors: clear, and hold the previous state until then", () => {
  const previous = { indexedQmdEmbedModel: "model-old", indexerSignature: "sig-0" };
  const cmp = compareIndexerState(CURRENT, { ...previous, hadReadyEntries: true });
  assert.equal(cmp.qmdResetNeeded, true);
  // Progress writes keep the old markers so a crash before the clear cannot
  // masquerade as a completed migration.
  assert.deepEqual(cmp.progressIndexerState, previous);
});

test("model change over an empty library clears nothing", () => {
  const cmp = compareIndexerState(CURRENT, {
    indexedQmdEmbedModel: undefined,
    indexerSignature: undefined,
    hadReadyEntries: false,
  });
  assert.equal(cmp.qmdEmbedModelChanged, true);
  assert.equal(cmp.qmdResetNeeded, false);
  assert.deepEqual(cmp.progressIndexerState, CURRENT);
});

test("markerless catalog with ready entries still resets, with no progress markers to hold", () => {
  // Pre-marker catalogs: vectors may exist but there is no recorded state.
  const cmp = compareIndexerState(CURRENT, {
    indexedQmdEmbedModel: undefined,
    indexerSignature: undefined,
    hadReadyEntries: true,
  });
  assert.equal(cmp.qmdResetNeeded, true);
  assert.equal(cmp.progressIndexerState, undefined);
});

const UNCHANGED_CMP: IndexerComparison = {
  current: CURRENT,
  qmdEmbedModelChanged: false,
  indexerSignatureChanged: false,
  qmdResetNeeded: false,
  progressIndexerState: CURRENT,
};

const QUIET_FACTS: IndexUpdateFacts = {
  previousCompleted: true,
  changedAttachments: 0,
  staleDocKeys: 0,
  orphanDocKeys: 0,
  allEntriesMatchPrevious: true,
};

const updateRows: Array<{
  name: string;
  cmp?: Partial<IndexerComparison>;
  facts?: Partial<IndexUpdateFacts>;
  want: { shortCircuit: boolean; keywordRebuild: boolean };
}> = [
  {
    name: "quiet sync after a completed run short-circuits everything",
    want: { shortCircuit: true, keywordRebuild: false },
  },
  {
    name: "an incomplete previous run forces a keyword rebuild and blocks the short-circuit",
    facts: { previousCompleted: false },
    want: { shortCircuit: false, keywordRebuild: true },
  },
  {
    name: "a signature change forces a keyword rebuild",
    cmp: { indexerSignatureChanged: true },
    want: { shortCircuit: false, keywordRebuild: true },
  },
  {
    name: "a model change blocks the short-circuit but keeps the incremental keyword path",
    cmp: { qmdEmbedModelChanged: true },
    want: { shortCircuit: false, keywordRebuild: false },
  },
  {
    name: "changed attachments run the incremental update",
    facts: { changedAttachments: 2 },
    want: { shortCircuit: false, keywordRebuild: false },
  },
  {
    name: "stale removals run the incremental update",
    facts: { staleDocKeys: 1 },
    want: { shortCircuit: false, keywordRebuild: false },
  },
  {
    name: "swept orphans force one index pass so their vectors get reaped",
    facts: { orphanDocKeys: 1 },
    want: { shortCircuit: false, keywordRebuild: false },
  },
  {
    name: "any entry-content drift blocks the short-circuit",
    facts: { allEntriesMatchPrevious: false },
    want: { shortCircuit: false, keywordRebuild: false },
  },
];

for (const row of updateRows) {
  test(`decideIndexUpdate: ${row.name}`, () => {
    assert.deepEqual(
      decideIndexUpdate({ ...UNCHANGED_CMP, ...row.cmp }, { ...QUIET_FACTS, ...row.facts }),
      row.want,
    );
  });
}
