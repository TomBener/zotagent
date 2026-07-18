import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AttachmentManifest } from "./types.js";
import {
  MANIFEST_EXT,
  assertManifestsCurrent,
  ensureDir,
  readManifestFile,
  resolveHomePath,
  writeManifestFile,
} from "./utils.js";

// The Artifact Store owns artifacts: the docKey→file mapping, staged pair
// publishes (publish-or-restore), the reuse verdict, rename adoption,
// tolerant discard, and the per-sync stale sweep. It speaks only in docKeys,
// identities, and verdicts — it never opens source files and never knows
// Zotero exists. See CONTEXT.md for the domain vocabulary.

/** The identity an artifact must prove it belongs to. */
export interface ArtifactIdentity {
  docKey: string;
  itemKey: string;
}

/** What an extractor produces. The store derives all paths from
 *  `manifest.docKey`; producers never compute paths. */
export interface BuiltArtifact {
  markdown: string;
  manifest: AttachmentManifest;
}

/** Final on-disk locations of the two halves of one artifact pair. Display
 *  and test seeding only — never write or unlink through these paths; all
 *  mutation goes through the store. */
export interface ArtifactPaths {
  normalizedPath: string;
  manifestPath: string;
}

/** Stat-only facts. `hasNormalized` requires size > 0: an empty normalized
 *  file is "no record", matching the reuse verdict. */
export interface ArtifactProbe {
  hasNormalized: boolean;
  hasManifest: boolean;
}

export type ManifestReadResult =
  | { status: "ok"; manifest: AttachmentManifest }
  | { status: "missing" }
  // Gunzip/JSON failure. `error` preserves the original throw so callers can
  // surface a LegacyManifestFormatError's migration hint verbatim.
  | { status: "unreadable"; error: unknown };

export type ReuseRefusal =
  | "missing"
  | "empty-normalized"
  | "unreadable-manifest"
  | "no-blocks"
  | "identity-mismatch"
  | "vertical-mismatch";

export type ReuseVerdict =
  // The parsed manifest is returned on success so no caller reads the gzip twice.
  | { reusable: true; manifest: AttachmentManifest }
  | { reusable: false; reason: ReuseRefusal };

/** New identity written into an adopted manifest — the fields the rename
 *  migration rewrites today (sync.ts), passed as data so the store stays
 *  ignorant of where they come from. */
export interface AdoptionTarget {
  docKey: string;
  itemKey: string;
  citationKey?: string;
  title: string;
  authors: string[];
  year?: string;
  abstract?: string;
  filePath: string;
}

export type AdoptOutcome =
  | { adopted: true }
  | {
      adopted: false;
      reason: "source-not-reusable" | "vertical-mismatch" | "adoption-failed";
      /** Set when reason === "source-not-reusable". */
      refusal?: ReuseRefusal;
      /** Set when reason === "adoption-failed". */
      error?: unknown;
    };

export interface SessionReport {
  /** docKeys judged stale: expected but never touched this session. */
  staleDocKeys: string[];
  /** Artifact files actually removed (stale pairs + staging residue). */
  sweptFiles: number;
}

/** Thrown by publish() for blank markdown or zero blocks. The message phrase
 *  is a frozen contract: sync's ODL fallback chain regex-matches
 *  "Extracted output was empty" to decide tier fallback. */
export class EmptyArtifactError extends Error {
  constructor(manifest: AttachmentManifest) {
    super(`Extracted output was empty for ${manifest.filePath}`);
    this.name = "EmptyArtifactError";
  }
}

/** Named mutation steps, exposed to tests via `onStep`. A hook that throws is
 *  treated exactly as if the step's own primitive threw, so every restore and
 *  tolerance branch is drivable against either adapter. */
export type StoreStep =
  | "publish:stage-write"
  | "publish:displace-old"
  | "publish:normalized-rename"
  | "publish:manifest-rename"
  | "adopt:normalized-move"
  | "adopt:manifest-move"
  | "adopt:identity-rewrite"
  | "discard:unlink"
  | "sweep:unlink";

export interface StoreTestHooks {
  onStep?: (step: StoreStep, docKey: string) => void;
}

/** Read-only face. engine, diagnose, and keyword-db depend on exactly this. */
export interface ArtifactReader {
  /** Pure mapping; same strings for the same docKey forever within one store. */
  pathsFor(docKey: string): ArtifactPaths;
  probe(docKey: string): ArtifactProbe;
  /** Total: never throws. */
  readManifest(docKey: string): ManifestReadResult;
  /** Normalized markdown; undefined when missing or empty. Never throws. */
  readNormalized(docKey: string): string | undefined;
  /** THE reuse rule, whole: pair complete, normalized non-empty, manifest
   *  readable with blocks, identity matches, and — iff `expectation` is
   *  provided — the recorded verticalText matches it. Omitting `expectation`
   *  reproduces the rollback path's deliberately laxer check. */
  reuseVerdict(identity: ArtifactIdentity, expectation?: { vertical: boolean }): ReuseVerdict;
}

/** One per sync run. publish() and a successful adopt() auto-touch (adopt
 *  touches both keys), so a session can never sweep its own writes. */
export interface ArtifactSession {
  touch(docKey: string): void;
  /** Sweep stale pairs and staging residue. Idempotent: repeat calls return
   *  the first report without re-sweeping. */
  finish(): SessionReport;
}

export interface ArtifactStore extends ArtifactReader {
  /** Staged replace with publish-or-restore semantics.
   *  - Rejects invalid records (EmptyArtifactError) before any I/O.
   *  - Stages both halves, displaces any existing pair aside, then renames
   *    the new pair in; on a THROWN failure at any step the previous pair is
   *    restored and staging is cleaned — strictly stronger than the old
   *    writeArtifactsAtomically, which could lose the previous normalized.
   *  - On process death mid-publish the final paths never hold a torn mix
   *    the reuse verdict would accept; worst case is re-extract next run,
   *    plus staging residue the next session's finish() sweeps. */
  publish(built: BuiltArtifact): void;

  /** Rename adoption: validate the source pair with the full reuse rule,
   *  move it to the new docKey, and rewrite the manifest identity preserving
   *  verticalText and blocks. Refuses before moving on vertical mismatch.
   *  A failure after both moves is deliberately NOT rolled back: the pair
   *  sits at the new docKey with the old identity, the reuse verdict returns
   *  identity-mismatch, and the caller re-extracts (self-heal). */
  adopt(from: ArtifactIdentity, to: AdoptionTarget, expectation?: { vertical: boolean }): AdoptOutcome;

  /** Remove both halves if present. Tolerant: absence, races, and unlink
   *  errors are success. Never throws. */
  discard(docKey: string): void;

  /** Start the per-sync lifecycle. `expectedDocKeys` = the previous
   *  catalog's docKeys (file-less previous entries still count as removed).
   *  Throws if a session is already active — concurrent syncs are
   *  unsupported. */
  beginSession(expectedDocKeys: Iterable<string>): ArtifactSession;
}

export interface StoreDirs {
  normalizedDir: string;
  manifestsDir: string;
}

export type ArtifactStoreFactory = (dirs: StoreDirs) => ArtifactStore;

// Staging residue left by crashed runs: `.new-<pid>-<ts>-<rand>` /
// `.stale-<pid>-<ts>-<rand>` siblings (plus writeManifestFile's `.tmp`
// stage of a staged manifest). Swept by ArtifactSession.finish().
const STAGING_RESIDUE_RE = /\.(?:new|stale)-\d+-\d+-\d+(?:\.tmp)?$/;

/** Shared write-side validity gate: publish refuses exactly what the reuse
 *  verdict would classify as absent. Exported for adapter parity. */
export function assertPublishable(built: BuiltArtifact): void {
  if (built.markdown.trim().length > 0 && built.manifest.blocks.length > 0) {
    return;
  }
  throw new EmptyArtifactError(built.manifest);
}

/** Manifest-content half of the reuse rule, shared by all adapters so the
 *  refusal ladder cannot drift between them. */
export function manifestRefusal(
  manifest: AttachmentManifest,
  identity: ArtifactIdentity,
  expectation?: { vertical: boolean },
): ReuseRefusal | undefined {
  if (!Array.isArray(manifest.blocks) || manifest.blocks.length === 0) return "no-blocks";
  if (manifest.docKey !== identity.docKey || manifest.itemKey !== identity.itemKey) {
    return "identity-mismatch";
  }
  if (expectation !== undefined && (manifest.verticalText === true) !== expectation.vertical) {
    return "vertical-mismatch";
  }
  return undefined;
}

/** The identity rewrite adoption performs, shared by all adapters.
 *  Preserves the old manifest's verticalText and blocks; everything else
 *  comes from the adoption target. (`normalizedPath` is rewritten for parity
 *  with the current on-disk format; the field is slated for removal.) */
export function rewriteManifestIdentity(
  old: AttachmentManifest,
  to: AdoptionTarget,
  normalizedPath: string,
): AttachmentManifest {
  return {
    docKey: to.docKey,
    itemKey: to.itemKey,
    ...(to.citationKey ? { citationKey: to.citationKey } : {}),
    title: to.title,
    authors: to.authors,
    ...(to.year ? { year: to.year } : {}),
    ...(to.abstract ? { abstract: to.abstract } : {}),
    filePath: to.filePath,
    normalizedPath,
    ...(old.verticalText ? { verticalText: true } : {}),
    blocks: old.blocks,
  };
}

/** Session bookkeeping shared by all adapters; only the sweeps differ. */
export function createArtifactSession(
  expectedDocKeys: Iterable<string>,
  hooks: {
    sweepDocKey: (docKey: string) => number;
    sweepResidue: () => number;
    onFinish: () => void;
  },
): ArtifactSession {
  const expected = new Set(expectedDocKeys);
  const touched = new Set<string>();
  let report: SessionReport | null = null;
  return {
    touch(docKey: string): void {
      if (report) throw new Error("Artifact session already finished.");
      touched.add(docKey);
    },
    finish(): SessionReport {
      if (report) return report;
      const staleDocKeys = [...expected].filter((docKey) => !touched.has(docKey));
      let sweptFiles = 0;
      for (const docKey of staleDocKeys) {
        sweptFiles += hooks.sweepDocKey(docKey);
      }
      sweptFiles += hooks.sweepResidue();
      report = { staleDocKeys, sweptFiles };
      hooks.onFinish();
      return report;
    },
  };
}

// docKeys are sha1 hex in production, but the store only relies on the
// weaker invariant it can enforce: a docKey is a single path segment.
function assertDocKeySegment(docKey: string): void {
  if (docKey.length === 0 || /[/\\ ]/.test(docKey)) {
    throw new Error(`Invalid docKey (must be a single path segment): ${JSON.stringify(docKey)}`);
  }
}

function tryRename(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    // best effort — a failed restore degrades to re-extract next run
  }
}

function tryUnlink(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Production adapter over the real filesystem. On construction it creates
 *  both directories and enforces the legacy-manifest guard, so every
 *  artifact consumer gets the guard without remembering to call it. */
export function openFsArtifactStore(dirs: StoreDirs, testHooks: StoreTestHooks = {}): ArtifactStore {
  const normalizedDir = resolveHomePath(dirs.normalizedDir);
  const manifestsDir = resolveHomePath(dirs.manifestsDir);
  ensureDir(normalizedDir);
  ensureDir(manifestsDir);
  assertManifestsCurrent(manifestsDir);

  const step = (name: StoreStep, docKey: string): void => {
    testHooks.onStep?.(name, docKey);
  };

  let activeSession: ArtifactSession | null = null;

  function pathsFor(docKey: string): ArtifactPaths {
    assertDocKeySegment(docKey);
    return {
      normalizedPath: resolve(normalizedDir, `${docKey}.md`),
      manifestPath: resolve(manifestsDir, `${docKey}${MANIFEST_EXT}`),
    };
  }

  function reuseVerdict(
    identity: ArtifactIdentity,
    expectation?: { vertical: boolean },
  ): ReuseVerdict {
    const { normalizedPath, manifestPath } = pathsFor(identity.docKey);
    const stats = statSync(normalizedPath, { throwIfNoEntry: false });
    if (!stats || !existsSync(manifestPath)) return { reusable: false, reason: "missing" };
    if (stats.size === 0) return { reusable: false, reason: "empty-normalized" };
    let manifest: AttachmentManifest;
    try {
      manifest = readManifestFile(manifestPath);
    } catch {
      return { reusable: false, reason: "unreadable-manifest" };
    }
    const refusal = manifestRefusal(manifest, identity, expectation);
    return refusal ? { reusable: false, reason: refusal } : { reusable: true, manifest };
  }

  function sweepPair(docKey: string): number {
    const { normalizedPath, manifestPath } = pathsFor(docKey);
    let removed = 0;
    for (const path of [manifestPath, normalizedPath]) {
      try {
        step("sweep:unlink", docKey);
        if (tryUnlink(path)) removed += 1;
      } catch {
        // tolerate injected faults exactly like unlink races
      }
    }
    return removed;
  }

  function sweepResidue(): number {
    let removed = 0;
    for (const dir of [normalizedDir, manifestsDir]) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!STAGING_RESIDUE_RE.test(name)) continue;
        try {
          step("sweep:unlink", name);
          if (tryUnlink(resolve(dir, name))) removed += 1;
        } catch {
          // tolerated
        }
      }
    }
    return removed;
  }

  return {
    pathsFor,

    probe(docKey: string): ArtifactProbe {
      const { normalizedPath, manifestPath } = pathsFor(docKey);
      const stats = statSync(normalizedPath, { throwIfNoEntry: false });
      return {
        hasNormalized: Boolean(stats && stats.size > 0),
        hasManifest: existsSync(manifestPath),
      };
    },

    readManifest(docKey: string): ManifestReadResult {
      const { manifestPath } = pathsFor(docKey);
      if (!existsSync(manifestPath)) return { status: "missing" };
      try {
        return { status: "ok", manifest: readManifestFile(manifestPath) };
      } catch (error) {
        return { status: "unreadable", error };
      }
    },

    readNormalized(docKey: string): string | undefined {
      const { normalizedPath } = pathsFor(docKey);
      const stats = statSync(normalizedPath, { throwIfNoEntry: false });
      if (!stats || stats.size === 0) return undefined;
      try {
        return readFileSync(normalizedPath, "utf-8");
      } catch {
        return undefined;
      }
    },

    reuseVerdict,

    publish(built: BuiltArtifact): void {
      assertPublishable(built);
      const docKey = built.manifest.docKey;
      const { normalizedPath, manifestPath } = pathsFor(docKey);
      const stamp = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const tempNormalized = `${normalizedPath}.new-${stamp}`;
      const tempManifest = `${manifestPath}.new-${stamp}`;
      const staleNormalized = `${normalizedPath}.stale-${stamp}`;
      const staleManifest = `${manifestPath}.stale-${stamp}`;
      let displacedNormalized = false;
      let displacedManifest = false;
      let publishedNormalized = false;
      let failed = false;
      try {
        step("publish:stage-write", docKey);
        writeFileSync(tempNormalized, built.markdown, "utf-8");
        writeManifestFile(tempManifest, built.manifest);

        step("publish:displace-old", docKey);
        if (existsSync(normalizedPath)) {
          renameSync(normalizedPath, staleNormalized);
          displacedNormalized = true;
        }
        if (existsSync(manifestPath)) {
          renameSync(manifestPath, staleManifest);
          displacedManifest = true;
        }

        step("publish:normalized-rename", docKey);
        renameSync(tempNormalized, normalizedPath);
        publishedNormalized = true;

        step("publish:manifest-rename", docKey);
        renameSync(tempManifest, manifestPath);
      } catch (err) {
        failed = true;
        if (publishedNormalized) tryRename(normalizedPath, tempNormalized);
        if (displacedNormalized) tryRename(staleNormalized, normalizedPath);
        if (displacedManifest) tryRename(staleManifest, manifestPath);
        throw err;
      } finally {
        tryUnlink(tempNormalized);
        tryUnlink(tempManifest);
        // On success these retire the displaced pair. On failure the pair was
        // renamed back into place above, so these are no-ops — unless that
        // restore itself failed, in which case the .stale-* copy is the only
        // surviving old data and must be left for the sweep, not destroyed.
        if (!failed) {
          tryUnlink(staleNormalized);
          tryUnlink(staleManifest);
        }
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
      const fromPaths = pathsFor(from.docKey);
      const toPaths = pathsFor(to.docKey);
      let movedNormalized = false;
      try {
        step("adopt:normalized-move", to.docKey);
        renameSync(fromPaths.normalizedPath, toPaths.normalizedPath);
        movedNormalized = true;
        step("adopt:manifest-move", to.docKey);
        renameSync(fromPaths.manifestPath, toPaths.manifestPath);
      } catch (error) {
        if (movedNormalized) tryRename(toPaths.normalizedPath, fromPaths.normalizedPath);
        return { adopted: false, reason: "adoption-failed", error };
      }
      try {
        step("adopt:identity-rewrite", to.docKey);
        writeManifestFile(
          toPaths.manifestPath,
          rewriteManifestIdentity(verdict.manifest, to, toPaths.normalizedPath),
        );
      } catch (error) {
        // Both halves moved; deliberately not rolled back. The pair now fails
        // the reuse verdict at the new identity, so the caller re-extracts.
        return { adopted: false, reason: "adoption-failed", error };
      }
      activeSession?.touch(from.docKey);
      activeSession?.touch(to.docKey);
      return { adopted: true };
    },

    discard(docKey: string): void {
      const { normalizedPath, manifestPath } = pathsFor(docKey);
      for (const path of [manifestPath, normalizedPath]) {
        try {
          step("discard:unlink", docKey);
          tryUnlink(path);
        } catch {
          // tolerate injected faults exactly like unlink races
        }
      }
    },

    beginSession(expectedDocKeys: Iterable<string>): ArtifactSession {
      if (activeSession) {
        throw new Error("An artifact session is already active; finish() it first.");
      }
      const session = createArtifactSession(expectedDocKeys, {
        sweepDocKey: sweepPair,
        sweepResidue,
        onFinish: () => {
          activeSession = null;
        },
      });
      activeSession = session;
      return session;
    },
  };
}
