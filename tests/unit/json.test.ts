import test from "node:test";
import assert from "node:assert/strict";

import { emitError, emitOk } from "../../src/json.js";

function captureConsole(run: () => void): string {
  const messages: string[] = [];
  const original = console.log;
  const originalExitCode = process.exitCode;
  console.log = (message?: unknown) => {
    messages.push(String(message ?? ""));
  };
  try {
    run();
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }
  return messages.join("\n");
}

test("emitOk emits a success envelope", () => {
  const output = captureConsole(() => emitOk({ results: [] }));
  const parsed = JSON.parse(output) as { ok: boolean; data: unknown; meta?: unknown };

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data, { results: [] });
  assert.equal("meta" in parsed, false);
});

test("emitOk includes non-empty meta", () => {
  const output = captureConsole(() => emitOk({ totalRecords: 0 }, { elapsedMs: 12 }));
  const parsed = JSON.parse(output) as {
    ok: boolean;
    data: unknown;
    meta?: { elapsedMs?: number };
  };

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data, { totalRecords: 0 });
  assert.equal(parsed.meta?.elapsedMs, 12);
});

test("emitError emits an error envelope", () => {
  const output = captureConsole(() => emitError("TEST", "failed"));
  const parsed = JSON.parse(output) as { ok: boolean; error: { code: string; message: string }; meta?: unknown };

  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "TEST");
  assert.equal(parsed.error.message, "failed");
  assert.equal("meta" in parsed, false);
});
