import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { DEFAULT_TOLERANCE_SECONDS, signWebhook, verifyWebhook, webhookHeaderNames } from "./notify-verify";

const KEY = "s3cret";
const NOW = 1_760_000_000;
const BODY = JSON.stringify({ schema: "chant.notify/v1", event: "waiting" });

function headers(body = BODY, ts: number | string = NOW, key = KEY, prefix = "x-chant"): Record<string, string> {
  return { [`${prefix}-timestamp`]: String(ts), [`${prefix}-signature`]: signWebhook(key, ts, body) };
}

describe("signWebhook", () => {
  test("is HMAC-SHA256 over <timestamp>.<body>, as sha256=<hex>", () => {
    const hex = createHmac("sha256", KEY).update(`${NOW}.${BODY}`).digest("hex");
    expect(signWebhook(KEY, NOW, BODY)).toBe(`sha256=${hex}`);
  });
});

describe("verifyWebhook", () => {
  test("accepts a fresh delivery signed with the key, and returns the event", () => {
    expect(verifyWebhook({ body: BODY, headers: headers(), key: KEY, now: NOW + 10 })).toEqual({ ok: true, event: JSON.parse(BODY) });
  });

  test("matches header names without regard to case, and reads a Headers object and a byte body", () => {
    const upper = Object.fromEntries(Object.entries(headers()).map(([k, v]) => [k.toUpperCase(), v]));
    expect(verifyWebhook({ body: BODY, headers: upper, key: KEY, now: NOW }).ok).toBe(true);
    expect(verifyWebhook({ body: new TextEncoder().encode(BODY), headers: new Headers(headers()), key: KEY, now: NOW }).ok).toBe(true);
  });

  test("refuses another key, a changed body, a moved timestamp and a missing key", () => {
    expect(verifyWebhook({ body: BODY, headers: headers(BODY, NOW, "other"), key: KEY, now: NOW })).toEqual({ ok: false, reason: "the signature does not match" });
    expect(verifyWebhook({ body: BODY + " ", headers: headers(), key: KEY, now: NOW }).ok).toBe(false);
    expect(verifyWebhook({ body: BODY, headers: { ...headers(), "x-chant-timestamp": String(NOW + 1) }, key: KEY, now: NOW }).ok).toBe(false);
    expect(verifyWebhook({ body: BODY, headers: headers(), key: "", now: NOW })).toEqual({ ok: false, reason: "no key to verify with" });
    expect(verifyWebhook({ body: BODY, headers: headers(), key: undefined, now: NOW }).ok).toBe(false);
  });

  test("refuses a replay older than the tolerance, and one from too far ahead", () => {
    const late = verifyWebhook({ body: BODY, headers: headers(), key: KEY, now: NOW + DEFAULT_TOLERANCE_SECONDS + 1 });
    expect(late).toEqual({ ok: false, reason: `the timestamp is more than ${DEFAULT_TOLERANCE_SECONDS}s from now` });
    expect(verifyWebhook({ body: BODY, headers: headers(), key: KEY, now: NOW - 61, toleranceSeconds: 60 }).ok).toBe(false);
    expect(verifyWebhook({ body: BODY, headers: headers(), key: KEY, now: NOW + DEFAULT_TOLERANCE_SECONDS }).ok).toBe(true);
  });

  test("refuses missing or malformed headers, and a body that is not JSON", () => {
    expect(verifyWebhook({ body: BODY, headers: {}, key: KEY, now: NOW })).toEqual({ ok: false, reason: "no x-chant-signature header" });
    expect(verifyWebhook({ body: BODY, headers: { "x-chant-signature": "sha256=00" }, key: KEY, now: NOW }).ok).toBe(false);
    expect(verifyWebhook({ body: BODY, headers: headers(BODY, "soon"), key: KEY, now: NOW }).ok).toBe(false);
    expect(verifyWebhook({ body: "not json", headers: headers("not json"), key: KEY, now: NOW })).toEqual({ ok: false, reason: "the body is not JSON" });
  });

  test("reads a product's own header prefix", () => {
    expect(webhookHeaderNames("X-Yodel")).toEqual({ signature: "x-yodel-signature", timestamp: "x-yodel-timestamp", event: "x-yodel-event", delivery: "x-yodel-delivery" });
    const h = headers(BODY, NOW, KEY, "x-yodel");
    expect(verifyWebhook({ body: BODY, headers: h, key: KEY, now: NOW, prefix: "x-yodel" }).ok).toBe(true);
    expect(verifyWebhook({ body: BODY, headers: h, key: KEY, now: NOW }).ok).toBe(false);
  });
});
