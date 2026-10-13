// The check for C-001 (../C-001-the-home-page-follows-its-screen-spec.md).
// Runs against the app at APP_URL with node --test; each test is named after
// the criterion it checks.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.APP_URL ?? "http://127.0.0.1:8080";

test("a1: the home page has the spec's header and status regions", async () => {
  const res = await fetch(`${url}/`);
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /<header><h1>[^<]+<\/h1><\/header>/);
  assert.match(page, /<main><p id="status">Running\.<\/p><\/main>/);
});

test("a2: the health check answers ok", async () => {
  const res = await fetch(`${url}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});
