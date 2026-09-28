import test from "node:test";
import assert from "node:assert/strict";

import { decideRemoval, MASS_REMOVAL_MIN_ITEMS } from "../../src/removal-guard.js";

function keys(prefix: string, count: number): Set<string> {
  return new Set(Array.from({ length: count }, (_, i) => `${prefix}${i}`));
}

const none = new Set<string>();

test("decideRemoval lets a first sync and routine removals through", () => {
  assert.deepEqual(
    decideRemoval({ previousItemKeys: none, currentItemKeys: none, excludedItemKeys: none }),
    { refuse: false, vanishedItems: 0 },
  );
  const previous = keys("I", 1000);
  const current = new Set([...previous].slice(0, 990));
  assert.deepEqual(
    decideRemoval({ previousItemKeys: previous, currentItemKeys: current, excludedItemKeys: none }),
    { refuse: false, vanishedItems: 10 },
  );
});

test("decideRemoval refuses when this run resolved no attachments", () => {
  assert.deepEqual(
    decideRemoval({ previousItemKeys: keys("I", 3), currentItemKeys: none, excludedItemKeys: none }),
    { refuse: true, reason: "no-attachments", vanishedItems: 3, previousItems: 3 },
  );
});

test("decideRemoval refuses a mass removal only past both thresholds", () => {
  const previous = keys("I", 1000);
  const keepAllBut = (n: number) => new Set([...previous].slice(n));
  // 10% of 1000 is the ceiling: exactly 100 vanished still proceeds.
  assert.equal(
    decideRemoval({ previousItemKeys: previous, currentItemKeys: keepAllBut(100), excludedItemKeys: none }).refuse,
    false,
  );
  assert.deepEqual(
    decideRemoval({ previousItemKeys: previous, currentItemKeys: keepAllBut(101), excludedItemKeys: none }),
    { refuse: true, reason: "mass-removal", vanishedItems: 101, previousItems: 1000 },
  );
  // A small library losing most of its items stays under the absolute floor.
  const small = keys("S", MASS_REMOVAL_MIN_ITEMS);
  assert.deepEqual(
    decideRemoval({ previousItemKeys: small, currentItemKeys: new Set(["S0"]), excludedItemKeys: none }),
    { refuse: false, vanishedItems: MASS_REMOVAL_MIN_ITEMS - 1 },
  );
});

test("decideRemoval never counts items removed by the exclusion tag", () => {
  const previous = keys("I", 200);
  const excluded = new Set([...previous].slice(0, 150));
  const current = new Set([...previous].slice(150));
  assert.deepEqual(
    decideRemoval({ previousItemKeys: previous, currentItemKeys: current, excludedItemKeys: excluded }),
    { refuse: false, vanishedItems: 0 },
  );
  // Excluding every item is intentional too, even though nothing remains.
  assert.deepEqual(
    decideRemoval({ previousItemKeys: previous, currentItemKeys: none, excludedItemKeys: previous }),
    { refuse: false, vanishedItems: 0 },
  );
});

test("decideRemoval counts by itemKey, so renamed files are not removals", () => {
  // Every attachment got a new path (new docKeys) but the same items remain.
  const previous = keys("I", 500);
  assert.deepEqual(
    decideRemoval({ previousItemKeys: previous, currentItemKeys: new Set(previous), excludedItemKeys: none }),
    { refuse: false, vanishedItems: 0 },
  );
});
