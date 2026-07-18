import type {
  AdoptOutcome,
  AdoptionTarget,
  ArtifactIdentity,
  ArtifactPaths,
  ArtifactProbe,
  ArtifactSession,
  ArtifactStore,
  BuiltArtifact,
  ManifestReadResult,
  ReuseVerdict,
  StoreStep,
  StoreTestHooks,
} from "../../src/artifact-store.js";
import {
  assertPublishable,
  createArtifactSession,
  manifestRefusal,
  rewriteManifestIdentity,
} from "../../src/artifact-store.js";
import type { AttachmentManifest } from "../../src/types.js";

// In-memory adapter of the ArtifactStore seam. Substrate: one record per
// docKey with independently missing halves, so half-pairs, empty normalized
// files, and unreadable manifests are all representable. Runs the same step
// sequence and shares the same refusal ladder / identity rewrite as the fs
// adapter, so a test written against step names runs against either.

export interface MemoryRecord {
  normalized?: string;
  manifest?: AttachmentManifest;
  /** readManifest reports "unreadable" while set, regardless of `manifest`. */
  corruptManifest?: boolean;
}

export interface MemoryArtifactStore extends ArtifactStore {
  records: Map<string, MemoryRecord>;
  /** Seeds BYPASS publish validation so consumers can be tested against
   *  invalid states the fs world can contain. */
  seed(docKey: string, record: MemoryRecord): void;
  markCorrupt(docKey: string): void;
}

export function openMemoryArtifactStore(testHooks: StoreTestHooks = {}): MemoryArtifactStore {
  const records = new Map<string, MemoryRecord>();
  let activeSession: ArtifactSession | null = null;

  const step = (name: StoreStep, docKey: string): void => {
    testHooks.onStep?.(name, docKey);
  };

  function pathsFor(docKey: string): ArtifactPaths {
    return {
      normalizedPath: `/memory/normalized/${docKey}.md`,
      manifestPath: `/memory/manifests/${docKey}.json.gz`,
    };
  }

  function reuseVerdict(
    identity: ArtifactIdentity,
    expectation?: { vertical: boolean },
  ): ReuseVerdict {
    const record = records.get(identity.docKey);
    const hasManifestHalf = Boolean(record && (record.manifest || record.corruptManifest));
    if (!record || record.normalized === undefined || !hasManifestHalf) {
      return { reusable: false, reason: "missing" };
    }
    if (record.normalized.length === 0) return { reusable: false, reason: "empty-normalized" };
    if (record.corruptManifest || !record.manifest) {
      return { reusable: false, reason: "unreadable-manifest" };
    }
    const refusal = manifestRefusal(record.manifest, identity, expectation);
    return refusal ? { reusable: false, reason: refusal } : { reusable: true, manifest: record.manifest };
  }

  function setOrDelete(docKey: string, record: MemoryRecord): void {
    if (record.normalized === undefined && !record.manifest && !record.corruptManifest) {
      records.delete(docKey);
    } else {
      records.set(docKey, record);
    }
  }

  function sweepPair(docKey: string): number {
    const record = records.get(docKey);
    let removed = 0;
    for (const half of ["manifest", "normalized"] as const) {
      try {
        step("sweep:unlink", docKey);
        if (!record) continue;
        if (half === "manifest" && (record.manifest || record.corruptManifest)) {
          delete record.manifest;
          delete record.corruptManifest;
          removed += 1;
        }
        if (half === "normalized" && record.normalized !== undefined) {
          delete record.normalized;
          removed += 1;
        }
      } catch {
        // tolerate injected faults exactly like unlink races
      }
    }
    if (record) setOrDelete(docKey, record);
    return removed;
  }

  return {
    records,

    seed(docKey: string, record: MemoryRecord): void {
      records.set(docKey, { ...record });
    },

    markCorrupt(docKey: string): void {
      const record = records.get(docKey) ?? {};
      record.corruptManifest = true;
      records.set(docKey, record);
    },

    pathsFor,

    probe(docKey: string): ArtifactProbe {
      const record = records.get(docKey);
      return {
        hasNormalized: Boolean(record?.normalized && record.normalized.length > 0),
        hasManifest: Boolean(record && (record.manifest || record.corruptManifest)),
      };
    },

    readManifest(docKey: string): ManifestReadResult {
      const record = records.get(docKey);
      if (!record || (!record.manifest && !record.corruptManifest)) return { status: "missing" };
      if (record.corruptManifest) {
        return { status: "unreadable", error: new Error(`Seeded corrupt manifest for ${docKey}`) };
      }
      return { status: "ok", manifest: record.manifest! };
    },

    readNormalized(docKey: string): string | undefined {
      const normalized = records.get(docKey)?.normalized;
      return normalized ? normalized : undefined;
    },

    reuseVerdict,

    publish(built: BuiltArtifact): void {
      assertPublishable(built);
      const docKey = built.manifest.docKey;
      const before = records.get(docKey);
      const snapshot = before ? { ...before } : undefined;
      try {
        step("publish:stage-write", docKey);
        step("publish:displace-old", docKey);
        step("publish:normalized-rename", docKey);
        records.set(docKey, { ...(records.get(docKey) ?? {}), normalized: built.markdown });
        step("publish:manifest-rename", docKey);
        records.set(docKey, { normalized: built.markdown, manifest: built.manifest });
      } catch (err) {
        // publish-or-restore: the previous record comes back intact
        if (snapshot) {
          records.set(docKey, snapshot);
        } else {
          records.delete(docKey);
        }
        throw err;
      }
      activeSession?.touch(docKey);
    },

    adopt(
      from: ArtifactIdentity,
      to: AdoptionTarget,
      expectation?: { vertical: boolean },
    ): AdoptOutcome {
      const verdict = reuseVerdict(from, expectation);
      if (!verdict.reusable) {
        return verdict.reason === "vertical-mismatch"
          ? { adopted: false, reason: "vertical-mismatch" }
          : { adopted: false, reason: "source-not-reusable", refusal: verdict.reason };
      }
      const fromBefore = { ...records.get(from.docKey)! };
      const toBefore = records.get(to.docKey);
      const toSnapshot = toBefore ? { ...toBefore } : undefined;
      try {
        step("adopt:normalized-move", to.docKey);
        const fromRecord = records.get(from.docKey)!;
        setOrDelete(to.docKey, { ...(records.get(to.docKey) ?? {}), normalized: fromRecord.normalized });
        setOrDelete(from.docKey, { ...fromRecord, normalized: undefined });

        step("adopt:manifest-move", to.docKey);
        const fromRest = records.get(from.docKey);
        setOrDelete(to.docKey, {
          ...(records.get(to.docKey) ?? {}),
          manifest: verdict.manifest,
        });
        if (fromRest) setOrDelete(from.docKey, { ...fromRest, manifest: undefined });
      } catch (error) {
        // roll back the half-done move
        records.set(from.docKey, fromBefore);
        if (toSnapshot) {
          records.set(to.docKey, toSnapshot);
        } else {
          records.delete(to.docKey);
        }
        return { adopted: false, reason: "adoption-failed", error };
      }
      try {
        step("adopt:identity-rewrite", to.docKey);
        const moved = records.get(to.docKey)!;
        records.set(to.docKey, {
          ...moved,
          manifest: rewriteManifestIdentity(verdict.manifest, to, pathsFor(to.docKey).normalizedPath),
        });
      } catch (error) {
        // Both halves moved; deliberately not rolled back (self-heal parity
        // with the fs adapter): the pair now fails the reuse verdict at the
        // new identity.
        return { adopted: false, reason: "adoption-failed", error };
      }
      activeSession?.touch(from.docKey);
      activeSession?.touch(to.docKey);
      return { adopted: true };
    },

    discard(docKey: string): void {
      const record = records.get(docKey);
      for (const half of ["manifest", "normalized"] as const) {
        try {
          step("discard:unlink", docKey);
          if (!record) continue;
          if (half === "manifest") {
            delete record.manifest;
            delete record.corruptManifest;
          } else {
            delete record.normalized;
          }
        } catch {
          // tolerated
        }
      }
      if (record) setOrDelete(docKey, record);
    },

    beginSession(expectedDocKeys: Iterable<string>): ArtifactSession {
      if (activeSession) {
        throw new Error("An artifact session is already active; finish() it first.");
      }
      const session = createArtifactSession(expectedDocKeys, {
        sweepDocKey: sweepPair,
        sweepResidue: () => 0,
        onFinish: () => {
          activeSession = null;
        },
      });
      activeSession = session;
      return session;
    },
  };
}
