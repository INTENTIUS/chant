import { test } from "node:test";
import assert from "node:assert/strict";
import { server } from "../server.mjs";

test("the app answers /health", async () => {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});
