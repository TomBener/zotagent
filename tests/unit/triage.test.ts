import test from "node:test";
import assert from "node:assert/strict";

import { decideTriage, type TriageDecision, type TriageFacts } from "../../src/triage.js";

// One row per lifecycle transition. `base` is the happiest path — a ready,
// unchanged, fully reusable PDF — and each row overrides just the facts that
// define its transition.
const base: TriageFacts = {
  supported: true,
  fileExists: true,
  isPdf: true,
  previousStatus: "ready",
  sizeMtimeUnchanged: true,
  artifactsReusable: true,
  artifactPairPresent: true,
  previousCatalogCompleted: true,
  retryErrors: false,
  hasRenameCandidate: false,
};

const rows: Array<{ name: string; over: Partial<TriageFacts>; want: TriageDecision }> = [
  {
    name: "unsupported wins over everything else",
    over: { supported: false, fileExists: false },
    want: { action: "record-unsupported" },
  },
  {
    name: "missing source file",
    over: { fileExists: false },
    want: { action: "record-missing" },
  },
  {
    name: "ready + unchanged + reusable reuses, carrying index state",
    over: {},
    want: { action: "reuse", carryPreviousIndexState: true },
  },
  {
    name: "PDFs never take the existence fast path — a failed verdict (e.g. vertical tag flip) re-extracts",
    over: { artifactsReusable: false },
    want: { action: "extract" },
  },
  {
    name: "non-PDF fast path accepts pair presence once a catalog completed",
    over: { isPdf: false, artifactsReusable: false },
    want: { action: "reuse", carryPreviousIndexState: true },
  },
  {
    name: "non-PDF without a completed catalog needs the full verdict",
    over: { isPdf: false, artifactsReusable: false, previousCatalogCompleted: false },
    want: { action: "extract" },
  },
  {
    name: "source changed since ready — matching artifacts are stale, re-extract (re-OCR rule)",
    over: { sizeMtimeUnchanged: false },
    want: { action: "extract" },
  },
  {
    name: "unchanged previous error is skipped without --retry-errors",
    over: { previousStatus: "error", artifactsReusable: false },
    want: { action: "skip-unchanged-error" },
  },
  {
    name: "--retry-errors forces the extract",
    over: { previousStatus: "error", artifactsReusable: false, retryErrors: true },
    want: { action: "extract" },
  },
  {
    name: "unchanged previous error with reusable artifacts recovers via reuse",
    over: { previousStatus: "error" },
    want: { action: "reuse", carryPreviousIndexState: false },
  },
  {
    name: "never seen + no artifacts + rename candidate adopts",
    over: {
      previousStatus: undefined,
      sizeMtimeUnchanged: false,
      artifactsReusable: false,
      hasRenameCandidate: true,
    },
    want: { action: "adopt-then-extract" },
  },
  {
    name: "never seen + no artifacts + no candidate extracts",
    over: { previousStatus: undefined, sizeMtimeUnchanged: false, artifactsReusable: false },
    want: { action: "extract" },
  },
  {
    name: "never seen but artifacts already on disk — recovery reuse without index state",
    over: { previousStatus: undefined, sizeMtimeUnchanged: false },
    want: { action: "reuse", carryPreviousIndexState: false },
  },
  {
    name: "a rename candidate never outranks reusable artifacts of our own",
    over: { previousStatus: undefined, sizeMtimeUnchanged: false, hasRenameCandidate: true },
    want: { action: "reuse", carryPreviousIndexState: false },
  },
  {
    name: "previously missing entry with artifacts on disk reuses without index state",
    over: { previousStatus: "missing", sizeMtimeUnchanged: false },
    want: { action: "reuse", carryPreviousIndexState: false },
  },
  {
    name: "a candidate for an already-known docKey is ignored — adoption is only for never-seen keys",
    over: { previousStatus: "error", artifactsReusable: false, hasRenameCandidate: true, retryErrors: true },
    want: { action: "extract" },
  },
];

for (const row of rows) {
  test(`decideTriage: ${row.name}`, () => {
    assert.deepEqual(decideTriage({ ...base, ...row.over }), row.want);
  });
}
