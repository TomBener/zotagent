import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { fetchWithTimeout } from "../../src/http.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

test("fetchWithTimeout's budget covers a body that stalls after the headers", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"partial":'); // never ends
  });
  const url = await listen(server);
  try {
    const started = Date.now();
    await assert.rejects(fetchWithTimeout(fetch, url, {}, 200), /Request timed out after 200ms/u);
    assert.ok(Date.now() - started < 5_000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("fetchWithTimeout hands back status, headers, and body intact", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(201, { "Total-Results": "7" });
    res.end("hello");
  });
  const url = await listen(server);
  try {
    const response = await fetchWithTimeout(fetch, url, {}, 2_000);
    assert.equal(response.status, 201);
    assert.equal(response.ok, true);
    assert.equal(response.headers.get("total-results"), "7");
    assert.equal(await response.text(), "hello");
  } finally {
    server.close();
  }
});

test("fetchWithTimeout accepts bodiless statuses", async () => {
  const response = await fetchWithTimeout(async () => new Response(null, { status: 204 }), "http://x/", {}, 1_000);
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});
