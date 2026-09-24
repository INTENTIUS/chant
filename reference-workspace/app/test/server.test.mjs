import { test } from "node:test";
import assert from "node:assert/strict";
import { createAppServer } from "../src/server.mjs";

async function withServer(fn) {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("serves the home page and the health check", async () => {
  await withServer(async (base) => {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /<h1>Reference app<\/h1>/);

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);
  });
});
