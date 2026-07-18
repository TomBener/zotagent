import test from "node:test";
import assert from "node:assert/strict";

import {
  BOOLEAN_FLAGS,
  COMMAND_FLAGS,
  COMMAND_FLAG_ALLOWLIST,
  GLOBAL_OVERRIDE_FLAGS,
  helpText,
} from "../../src/cli-spec.js";

// The help text is hand-written prose; the flag table is what the parser
// enforces. These tests pin the two to each other so adding a flag in one
// place and forgetting the other fails a unit test instead of drifting.

test("every declared command appears in the help text", () => {
  const help = helpText();
  for (const command of Object.keys(COMMAND_FLAGS)) {
    assert.ok(
      new RegExp(`(^|[\\s])${command}([\\s:,]|$)`, "mu").test(help),
      `command "${command}" is missing from the help text`,
    );
  }
});

test("every declared command flag is documented in the help text", () => {
  const help = helpText();
  const documented = new Set([...help.matchAll(/--([a-z0-9-]+)/gu)].map((m) => m[1]!));
  for (const [command, specs] of Object.entries(COMMAND_FLAGS)) {
    for (const spec of specs) {
      assert.ok(
        documented.has(spec.name),
        `--${spec.name} (${command}) is declared but not documented in help`,
      );
    }
  }
});

test("config-only override flags deliberately stay out of the help text", () => {
  // The help is the agent-facing command surface; config overrides are
  // plumbing (documented via `zotagent config` and the README) and would
  // drown the command flags. The integration suite pins the same policy.
  const help = helpText();
  const documented = new Set([...help.matchAll(/--([a-z0-9-]+)/gu)].map((m) => m[1]!));
  const commandFlagNames = new Set(
    Object.values(COMMAND_FLAGS).flatMap((specs) => specs.map((spec) => spec.name)),
  );
  for (const flag of GLOBAL_OVERRIDE_FLAGS) {
    if (commandFlagNames.has(flag)) continue; // e.g. --attachments-root is also a sync flag
    assert.ok(
      !documented.has(flag),
      `config-only override --${flag} must not appear in the help text`,
    );
  }
});

test("every flag the help text mentions is a declared flag", () => {
  const declared = new Set<string>([
    ...GLOBAL_OVERRIDE_FLAGS,
    ...Object.values(COMMAND_FLAGS).flatMap((specs) => specs.map((spec) => spec.name)),
    "help",
    "version",
    // Prose exception: describes OpenDataLoader's extraction flag, not ours.
    "reading-order",
  ]);
  for (const match of helpText().matchAll(/--([a-z0-9-]+)/gu)) {
    assert.ok(
      declared.has(match[1]!),
      `help documents --${match[1]} but no command declares it`,
    );
  }
});

test("derived structures reflect the table", () => {
  // Booleans: exactly the spec rows marked boolean, plus help/version.
  const expectedBooleans = new Set([
    "help",
    "version",
    ...Object.values(COMMAND_FLAGS).flatMap((specs) =>
      specs.filter((spec) => spec.boolean).map((spec) => spec.name),
    ),
  ]);
  assert.deepEqual([...BOOLEAN_FLAGS].sort(), [...expectedBooleans].sort());

  // Allowlists: same commands, same flags, declaration order preserved.
  assert.deepEqual(Object.keys(COMMAND_FLAG_ALLOWLIST), Object.keys(COMMAND_FLAGS));
  for (const [command, specs] of Object.entries(COMMAND_FLAGS)) {
    assert.deepEqual(
      COMMAND_FLAG_ALLOWLIST[command],
      specs.map((spec) => spec.name),
      `allowlist order for ${command}`,
    );
  }
});
