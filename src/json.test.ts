import test from "node:test";
import assert from "node:assert/strict";

import { emitError, emitOk } from "./json.js";

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

test("emitOk omits empty meta", () => {
  const output = captureConsole(() => emitOk({ results: [] }));
  const parsed = JSON.parse(output) as { ok: boolean; data: unknown; meta?: unknown };

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data, { results: [] });
  assert.equal("meta" in parsed, false);
});

test("emitError omits empty meta", () => {
  const output = captureConsole(() => emitError("TEST", "failed"));
  const parsed = JSON.parse(output) as { ok: boolean; error: { code: string; message: string }; meta?: unknown };

  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "TEST");
  assert.equal(parsed.error.message, "failed");
  assert.equal("meta" in parsed, false);
});
