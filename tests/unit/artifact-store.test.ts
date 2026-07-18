import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ArtifactStore,
  BuiltArtifact,
  StoreStep,
  StoreTestHooks,
} from "../../src/artifact-store.js";
import { EmptyArtifactError, openFsArtifactStore } from "../../src/artifact-store.js";
import { openMemoryArtifactStore } from "../helpers/memory-artifact-store.js";
import { LegacyManifestFormatError, MANIFEST_EXT, writeManifestFile } from "../../src/utils.js";
import type { AttachmentManifest, ManifestBlock } from "../../src/types.js";

function sampleBlock(text = "hello world"): ManifestBlock {
  return {
    blockIndex: 0,
    sectionPath: [],
    blockType: "paragraph",
    text,
    charStart: 0,
    charEnd: text.length,
    lineStart: 0,
    lineEnd: 0,
    isReferenceLike: false,
  };
}

function sampleManifest(docKey: string, over: Partial<AttachmentManifest> = {}): AttachmentManifest {
  return {
    docKey,
    itemKey: `ITEM-${docKey}`,
    title: `Title ${docKey}`,
    authors: ["A"],
    filePath: `/tmp/${docKey}.pdf`,
    normalizedPath: "",
    blocks: [sampleBlock()],
    ...over,
  };
}

function built(docKey: string, over: Partial<AttachmentManifest> = {}, markdown = "hello world"): BuiltArtifact {
  return { markdown, manifest: sampleManifest(docKey, over) };
}

interface SeedRaw {
  markdown?: string;
  manifest?: AttachmentManifest;
  corruptManifest?: boolean;
}

interface Harness {
  name: string;
  make(hooks?: StoreTestHooks): {
    store: ArtifactStore;
    seedRaw(docKey: string, raw: SeedRaw): void;
  };
}

function makeFsHarness(hooks: StoreTestHooks = {}) {
  const base = mkdtempSync(join(tmpdir(), "zotagent-store-"));
  const dirs = { normalizedDir: join(base, "normalized"), manifestsDir: join(base, "manifests") };
  const store = openFsArtifactStore(dirs, hooks);
  return {
    store,
    dirs,
    seedRaw(docKey: string, raw: SeedRaw): void {
      if (raw.markdown !== undefined) {
        writeFileSync(join(dirs.normalizedDir, `${docKey}.md`), raw.markdown, "utf-8");
      }
      if (raw.corruptManifest) {
        writeFileSync(join(dirs.manifestsDir, `${docKey}${MANIFEST_EXT}`), "not gzip at all");
      } else if (raw.manifest) {
        writeManifestFile(join(dirs.manifestsDir, `${docKey}${MANIFEST_EXT}`), raw.manifest);
      }
    },
  };
}

const harnesses: Harness[] = [
  { name: "fs", make: (hooks) => makeFsHarness(hooks) },
  {
    name: "memory",
    make: (hooks) => {
      const store = openMemoryArtifactStore(hooks);
      return {
        store,
        seedRaw(docKey: string, raw: SeedRaw): void {
          store.seed(docKey, {
            ...(raw.markdown !== undefined ? { normalized: raw.markdown } : {}),
            ...(raw.manifest ? { manifest: raw.manifest } : {}),
            ...(raw.corruptManifest ? { corruptManifest: true } : {}),
          });
        },
      };
    },
  },
];

for (const harness of harnesses) {
  const t = (name: string, fn: () => void) => test(`[${harness.name}] ${name}`, fn);

  t("publish then read back through every read method", () => {
    const { store } = harness.make();
    store.publish(built("DOC1"));

    assert.equal(store.readNormalized("DOC1"), "hello world");
    const read = store.readManifest("DOC1");
    assert.equal(read.status, "ok");
    assert.deepEqual(store.probe("DOC1"), { hasNormalized: true, hasManifest: true });
    const verdict = store.reuseVerdict({ docKey: "DOC1", itemKey: "ITEM-DOC1" });
    assert.ok(verdict.reusable);
    assert.equal(verdict.manifest.title, "Title DOC1");
  });

  t("publish rejects blank markdown with the frozen message and stores nothing", () => {
    const { store } = harness.make();
    assert.throws(
      () => store.publish(built("DOC1", {}, "   \n ")),
      (err: unknown) =>
        err instanceof EmptyArtifactError &&
        err.message === "Extracted output was empty for /tmp/DOC1.pdf",
    );
    assert.deepEqual(store.probe("DOC1"), { hasNormalized: false, hasManifest: false });
  });

  t("publish rejects a zero-block manifest", () => {
    const { store } = harness.make();
    assert.throws(() => store.publish(built("DOC1", { blocks: [] })), EmptyArtifactError);
    assert.deepEqual(store.probe("DOC1"), { hasNormalized: false, hasManifest: false });
  });

  t("publish replaces an existing pair", () => {
    const { store } = harness.make();
    store.publish(built("DOC1", { title: "old" }, "old text"));
    store.publish(built("DOC1", { title: "new" }, "new text"));
    assert.equal(store.readNormalized("DOC1"), "new text");
    const verdict = store.reuseVerdict({ docKey: "DOC1", itemKey: "ITEM-DOC1" });
    assert.ok(verdict.reusable);
    assert.equal(verdict.manifest.title, "new");
  });

  t("reuseVerdict refusal ladder", () => {
    const { store, seedRaw } = harness.make();
    const id = (k: string) => ({ docKey: k, itemKey: `ITEM-${k}` });

    assert.deepEqual(store.reuseVerdict(id("NONE")), { reusable: false, reason: "missing" });

    seedRaw("HALF", { markdown: "content" });
    assert.deepEqual(store.reuseVerdict(id("HALF")), { reusable: false, reason: "missing" });

    seedRaw("EMPTY", { markdown: "", manifest: sampleManifest("EMPTY") });
    assert.deepEqual(store.reuseVerdict(id("EMPTY")), { reusable: false, reason: "empty-normalized" });

    seedRaw("CORRUPT", { markdown: "content", corruptManifest: true });
    assert.deepEqual(store.reuseVerdict(id("CORRUPT")), { reusable: false, reason: "unreadable-manifest" });

    seedRaw("NOBLOCKS", { markdown: "content", manifest: sampleManifest("NOBLOCKS", { blocks: [] }) });
    assert.deepEqual(store.reuseVerdict(id("NOBLOCKS")), { reusable: false, reason: "no-blocks" });

    seedRaw("WRONGID", { markdown: "content", manifest: sampleManifest("WRONGID", { itemKey: "OTHER" }) });
    assert.deepEqual(store.reuseVerdict(id("WRONGID")), { reusable: false, reason: "identity-mismatch" });
  });

  t("reuseVerdict vertical expectation, both directions, and omitted", () => {
    const { store, seedRaw } = harness.make();
    seedRaw("HORIZ", { markdown: "content", manifest: sampleManifest("HORIZ") });
    seedRaw("VERT", { markdown: "content", manifest: sampleManifest("VERT", { verticalText: true }) });
    const horiz = { docKey: "HORIZ", itemKey: "ITEM-HORIZ" };
    const vert = { docKey: "VERT", itemKey: "ITEM-VERT" };

    assert.deepEqual(store.reuseVerdict(horiz, { vertical: true }), {
      reusable: false,
      reason: "vertical-mismatch",
    });
    assert.deepEqual(store.reuseVerdict(vert, { vertical: false }), {
      reusable: false,
      reason: "vertical-mismatch",
    });
    assert.ok(store.reuseVerdict(horiz, { vertical: false }).reusable);
    assert.ok(store.reuseVerdict(vert, { vertical: true }).reusable);
    // rollback-path laxness: no expectation → verticalText is not consulted
    assert.ok(store.reuseVerdict(horiz).reusable);
    assert.ok(store.reuseVerdict(vert).reusable);
  });

  t("adopt moves the pair and rewrites identity, preserving verticalText and blocks", () => {
    const { store, seedRaw } = harness.make();
    const blocks = [sampleBlock("原文")];
    seedRaw("OLD", { markdown: "原文", manifest: sampleManifest("OLD", { verticalText: true, blocks }) });

    const outcome = store.adopt(
      { docKey: "OLD", itemKey: "ITEM-OLD" },
      {
        docKey: "NEW",
        itemKey: "ITEM-NEW",
        citationKey: "cite2026",
        title: "New Title",
        authors: ["B"],
        year: "2026",
        filePath: "/tmp/renamed.pdf",
      },
      { vertical: true },
    );

    assert.deepEqual(outcome, { adopted: true });
    assert.deepEqual(store.reuseVerdict({ docKey: "OLD", itemKey: "ITEM-OLD" }), {
      reusable: false,
      reason: "missing",
    });
    const verdict = store.reuseVerdict({ docKey: "NEW", itemKey: "ITEM-NEW" });
    assert.ok(verdict.reusable);
    assert.equal(verdict.manifest.docKey, "NEW");
    assert.equal(verdict.manifest.itemKey, "ITEM-NEW");
    assert.equal(verdict.manifest.citationKey, "cite2026");
    assert.equal(verdict.manifest.title, "New Title");
    assert.equal(verdict.manifest.filePath, "/tmp/renamed.pdf");
    assert.equal(verdict.manifest.verticalText, true);
    assert.deepEqual(verdict.manifest.blocks, blocks);
    assert.equal(verdict.manifest.normalizedPath, store.pathsFor("NEW").normalizedPath);
    assert.equal(store.readNormalized("NEW"), "原文");
  });

  t("adopt refuses an unusable source without mutating anything", () => {
    const { store } = harness.make();
    const outcome = store.adopt(
      { docKey: "OLD", itemKey: "ITEM-OLD" },
      { docKey: "NEW", itemKey: "ITEM-NEW", title: "T", authors: [], filePath: "/tmp/x.pdf" },
    );
    assert.deepEqual(outcome, { adopted: false, reason: "source-not-reusable", refusal: "missing" });
    assert.deepEqual(store.probe("NEW"), { hasNormalized: false, hasManifest: false });
  });

  t("adopt refuses a vertical mismatch before moving", () => {
    const { store, seedRaw } = harness.make();
    seedRaw("OLD", { markdown: "content", manifest: sampleManifest("OLD") });
    const outcome = store.adopt(
      { docKey: "OLD", itemKey: "ITEM-OLD" },
      { docKey: "NEW", itemKey: "ITEM-NEW", title: "T", authors: [], filePath: "/tmp/x.pdf" },
      { vertical: true },
    );
    assert.deepEqual(outcome, { adopted: false, reason: "vertical-mismatch" });
    assert.ok(store.reuseVerdict({ docKey: "OLD", itemKey: "ITEM-OLD" }).reusable);
    assert.deepEqual(store.probe("NEW"), { hasNormalized: false, hasManifest: false });
  });

  t("discard removes the pair and tolerates absence", () => {
    const { store } = harness.make();
    store.publish(built("DOC1"));
    store.discard("DOC1");
    assert.deepEqual(store.probe("DOC1"), { hasNormalized: false, hasManifest: false });
    store.discard("DOC1");
    store.discard("NEVER-EXISTED");
  });

  t("session sweeps expected-but-untouched pairs and is idempotent", () => {
    const { store, seedRaw } = harness.make();
    seedRaw("KEEP", { markdown: "content", manifest: sampleManifest("KEEP") });
    seedRaw("STALE", { markdown: "content", manifest: sampleManifest("STALE") });

    const session = store.beginSession(["KEEP", "STALE", "GONE-ALREADY"]);
    session.touch("KEEP");
    const report = session.finish();

    assert.deepEqual(report.staleDocKeys.sort(), ["GONE-ALREADY", "STALE"]);
    assert.equal(report.sweptFiles, 2);
    assert.deepEqual(store.probe("STALE"), { hasNormalized: false, hasManifest: false });
    assert.ok(store.reuseVerdict({ docKey: "KEEP", itemKey: "ITEM-KEEP" }).reusable);
    assert.equal(session.finish(), report);
    assert.throws(() => session.touch("LATE"));
  });

  t("publish and adopt auto-touch the active session", () => {
    const { store, seedRaw } = harness.make();
    seedRaw("OLD", { markdown: "content", manifest: sampleManifest("OLD") });

    const session = store.beginSession(["OLD", "FRESH"]);
    store.publish(built("FRESH"));
    const outcome = store.adopt(
      { docKey: "OLD", itemKey: "ITEM-OLD" },
      { docKey: "NEW", itemKey: "ITEM-NEW", title: "T", authors: [], filePath: "/tmp/x.pdf" },
    );
    assert.deepEqual(outcome, { adopted: true });

    const report = session.finish();
    assert.deepEqual(report.staleDocKeys, []);
    assert.ok(store.reuseVerdict({ docKey: "NEW", itemKey: "ITEM-NEW" }).reusable);
    assert.ok(store.reuseVerdict({ docKey: "FRESH", itemKey: "ITEM-FRESH" }).reusable);
  });

  t("only one session may be active; a finished session frees the slot", () => {
    const { store } = harness.make();
    const first = store.beginSession([]);
    assert.throws(() => store.beginSession([]));
    first.finish();
    const second = store.beginSession([]);
    second.finish();
  });
}

// ---------- fs-adapter-only: fault injection and on-disk facts ----------

function armedHook(): { hooks: StoreTestHooks; failAt: (step: StoreStep) => void } {
  let target: StoreStep | null = null;
  return {
    hooks: {
      onStep: (step) => {
        if (step === target) {
          target = null;
          throw new Error(`injected fault at ${step}`);
        }
      },
    },
    failAt: (step) => {
      target = step;
    },
  };
}

function dirListing(dir: string): string[] {
  return readdirSync(dir).sort();
}

test("[fs] publish restores the previous pair when the manifest rename fails", () => {
  const { hooks, failAt } = armedHook();
  const { store, dirs } = makeFsHarness(hooks);
  store.publish(built("DOC1", { title: "v1" }, "one"));

  failAt("publish:manifest-rename");
  assert.throws(() => store.publish(built("DOC1", { title: "v2" }, "two")), /injected fault/);

  assert.equal(store.readNormalized("DOC1"), "one");
  const verdict = store.reuseVerdict({ docKey: "DOC1", itemKey: "ITEM-DOC1" });
  assert.ok(verdict.reusable);
  assert.equal(verdict.manifest.title, "v1");
  assert.deepEqual(dirListing(dirs.normalizedDir), ["DOC1.md"]);
  assert.deepEqual(dirListing(dirs.manifestsDir), [`DOC1${MANIFEST_EXT}`]);
});

test("[fs] publish restores the previous pair when the normalized rename fails", () => {
  const { hooks, failAt } = armedHook();
  const { store, dirs } = makeFsHarness(hooks);
  store.publish(built("DOC1", { title: "v1" }, "one"));

  failAt("publish:normalized-rename");
  assert.throws(() => store.publish(built("DOC1", { title: "v2" }, "two")), /injected fault/);

  assert.equal(store.readNormalized("DOC1"), "one");
  assert.deepEqual(dirListing(dirs.normalizedDir), ["DOC1.md"]);
  assert.deepEqual(dirListing(dirs.manifestsDir), [`DOC1${MANIFEST_EXT}`]);
});

test("[fs] publish failure after staging leaves finals untouched and no residue", () => {
  const { hooks, failAt } = armedHook();
  const { store, dirs } = makeFsHarness(hooks);
  store.publish(built("DOC1", { title: "v1" }, "one"));

  failAt("publish:displace-old");
  assert.throws(() => store.publish(built("DOC1", { title: "v2" }, "two")), /injected fault/);

  assert.equal(store.readNormalized("DOC1"), "one");
  assert.deepEqual(dirListing(dirs.normalizedDir), ["DOC1.md"]);
  assert.deepEqual(dirListing(dirs.manifestsDir), [`DOC1${MANIFEST_EXT}`]);
});

test("[fs] adopt rolls the first move back when the manifest move fails", () => {
  const { hooks, failAt } = armedHook();
  const { store } = makeFsHarness(hooks);
  store.publish(built("OLD", {}, "content"));

  failAt("adopt:manifest-move");
  const outcome = store.adopt(
    { docKey: "OLD", itemKey: "ITEM-OLD" },
    { docKey: "NEW", itemKey: "ITEM-NEW", title: "T", authors: [], filePath: "/tmp/x.pdf" },
  );

  assert.equal(outcome.adopted, false);
  assert.ok(!outcome.adopted && outcome.reason === "adoption-failed");
  assert.ok(store.reuseVerdict({ docKey: "OLD", itemKey: "ITEM-OLD" }).reusable);
  assert.deepEqual(store.probe("NEW"), { hasNormalized: false, hasManifest: false });
});

test("[fs] adopt failure after both moves self-heals via identity-mismatch", () => {
  const { hooks, failAt } = armedHook();
  const { store } = makeFsHarness(hooks);
  store.publish(built("OLD", {}, "content"));

  failAt("adopt:identity-rewrite");
  const outcome = store.adopt(
    { docKey: "OLD", itemKey: "ITEM-OLD" },
    { docKey: "NEW", itemKey: "ITEM-NEW", title: "T", authors: [], filePath: "/tmp/x.pdf" },
  );

  assert.ok(!outcome.adopted && outcome.reason === "adoption-failed");
  // The pair sits at the new docKey with the old identity: the reuse verdict
  // refuses it, which is exactly what forces the caller to re-extract.
  assert.deepEqual(store.probe("NEW"), { hasNormalized: true, hasManifest: true });
  assert.deepEqual(store.reuseVerdict({ docKey: "NEW", itemKey: "ITEM-NEW" }), {
    reusable: false,
    reason: "identity-mismatch",
  });
  assert.deepEqual(store.reuseVerdict({ docKey: "OLD", itemKey: "ITEM-OLD" }), {
    reusable: false,
    reason: "missing",
  });
});

test("[fs] session sweep removes staging residue but never a live pair", () => {
  const { store, dirs, seedRaw } = makeFsHarness();
  seedRaw("LIVE", { markdown: "content", manifest: sampleManifest("LIVE") });
  writeFileSync(join(dirs.normalizedDir, "X.md.new-1-2-3"), "residue");
  writeFileSync(join(dirs.manifestsDir, `X${MANIFEST_EXT}.stale-4-5-6`), "residue");
  writeFileSync(join(dirs.manifestsDir, `Y${MANIFEST_EXT}.new-7-8-9.tmp`), "residue");

  const report = store.beginSession([]).finish();

  assert.equal(report.sweptFiles, 3);
  assert.deepEqual(dirListing(dirs.normalizedDir), ["LIVE.md"]);
  assert.deepEqual(dirListing(dirs.manifestsDir), [`LIVE${MANIFEST_EXT}`]);
});

test("[fs] session sweep tolerates unlink faults and still reports stale docKeys", () => {
  const hooks: StoreTestHooks = {
    onStep: (step) => {
      if (step === "sweep:unlink") throw new Error("EACCES (injected)");
    },
  };
  const { store, seedRaw } = makeFsHarness(hooks);
  seedRaw("STALE", { markdown: "content", manifest: sampleManifest("STALE") });

  const report = store.beginSession(["STALE"]).finish();

  assert.deepEqual(report.staleDocKeys, ["STALE"]);
  assert.equal(report.sweptFiles, 0);
});

test("[fs] construction creates directories and enforces the legacy-manifest guard", () => {
  const base = mkdtempSync(join(tmpdir(), "zotagent-store-"));
  const dirs = { normalizedDir: join(base, "normalized"), manifestsDir: join(base, "manifests") };

  const store = openFsArtifactStore(dirs);
  assert.ok(existsSync(dirs.normalizedDir));
  assert.ok(existsSync(dirs.manifestsDir));
  store.publish(built("DOC1"));

  writeFileSync(join(dirs.manifestsDir, "legacy.json"), "{}");
  assert.throws(
    () => openFsArtifactStore(dirs),
    (err: unknown) => err instanceof Error && /migrate-gzip-manifests/.test(err.message),
  );
});

test("[fs] readManifest surfaces non-gzip bytes as unreadable with the legacy error", () => {
  const { store, seedRaw } = makeFsHarness();
  seedRaw("CORRUPT", { markdown: "content", corruptManifest: true });

  const result = store.readManifest("CORRUPT");
  assert.equal(result.status, "unreadable");
  assert.ok(result.status === "unreadable" && result.error instanceof LegacyManifestFormatError);
});

test("[fs] pathsFor rejects docKeys that are not a single path segment", () => {
  const { store } = makeFsHarness();
  assert.throws(() => store.pathsFor("../escape"));
  assert.throws(() => store.pathsFor("a/b"));
  assert.throws(() => store.pathsFor(""));
});
