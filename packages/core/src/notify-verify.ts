/**
 * Signing and checking a notify event (#3761). This module needs only
 * `node:crypto`, so a receiver can import it alone and bundle nothing else:
 *
 * ```ts
 * import { verifyWebhook } from "@intentius/chant/notify-verify";
 *
 * const checked = verifyWebhook({ body, headers: req.headers, key: process.env.CHANT_WEBHOOK_KEY });
 * if (!checked.ok) return reply(401, checked.reason);
 * handle(checked.event);
 * ```
 *
 * The signature is HMAC-SHA256, keyed with the shared secret, over
 * `<timestamp>.<body>`: the timestamp header (seconds since the epoch), a
 * dot, and the request body exactly as sent. It travels as
 * `x-chant-signature: sha256=<hex>`. Signing the timestamp with the body lets
 * a receiver refuse a delivery replayed later; {@link verifyWebhook} refuses
 * one more than five minutes from now by default. This is SQL Yodeler's
 * scheme (#3756), with the header prefix a product can keep as its own.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** The header names' default prefix. A product passes its own (`x-yodel`, `x-terragucci`) to keep its receivers working. */
export const DEFAULT_HEADER_PREFIX = "x-chant";

/** The four headers a delivery carries, under `prefix`. */
export function webhookHeaderNames(prefix: string = DEFAULT_HEADER_PREFIX): { signature: string; timestamp: string; event: string; delivery: string } {
  const p = prefix.toLowerCase();
  return { signature: `${p}-signature`, timestamp: `${p}-timestamp`, event: `${p}-event`, delivery: `${p}-delivery` };
}

/** How far from now a delivery's timestamp {@link verifyWebhook} still accepts, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** `sha256=<hex>` of `<timestamp>.<body>`, keyed with `key`. */
export function signWebhook(key: string, timestamp: number | string, body: string): string {
  return `sha256=${createHmac("sha256", key).update(`${String(timestamp)}.${body}`, "utf8").digest("hex")}`;
}

export type WebhookHeaders = Record<string, string | readonly string[] | undefined> | Headers;

export interface VerifyWebhookInput {
  /** The request body exactly as received, before any JSON parsing. */
  body: string | Uint8Array;
  /** The request's headers; names match without regard to case. */
  headers: WebhookHeaders;
  /** The shared secret. An empty or missing key never verifies. */
  key: string | undefined;
  /** Now, in seconds since the epoch. Default: the clock. */
  now?: number;
  /** How far from now the timestamp may be, in seconds. Default {@link DEFAULT_TOLERANCE_SECONDS}. */
  toleranceSeconds?: number;
  /** The header names' prefix the sender used. Default {@link DEFAULT_HEADER_PREFIX}. */
  prefix?: string;
}

export type VerifyWebhookResult = { ok: true; event: unknown } | { ok: false; reason: string };

function header(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  for (const [k, v] of Object.entries(headers as Record<string, string | readonly string[] | undefined>)) {
    if (k.toLowerCase() !== name) continue;
    return Array.isArray(v) ? (v[0] as string | undefined) : (v as string | undefined);
  }
  return undefined;
}

/**
 * Whether a delivery was signed with `key` and is recent: the signature
 * header matches (compared in constant time) and the timestamp is within the
 * tolerance either side of now. On success, the parsed event.
 */
export function verifyWebhook(input: VerifyWebhookInput): VerifyWebhookResult {
  if (!input.key) return { ok: false, reason: "no key to verify with" };
  const names = webhookHeaderNames(input.prefix);
  const body = typeof input.body === "string" ? input.body : Buffer.from(input.body).toString("utf8");
  const signature = header(input.headers, names.signature);
  const timestamp = header(input.headers, names.timestamp);
  if (!signature) return { ok: false, reason: `no ${names.signature} header` };
  if (!timestamp || !/^\d+$/.test(timestamp)) return { ok: false, reason: `no ${names.timestamp} header, or not a number of seconds` };
  const expected = Buffer.from(signWebhook(input.key, timestamp, body));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "the signature does not match" };
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - Number(timestamp)) > tolerance) return { ok: false, reason: `the timestamp is more than ${String(tolerance)}s from now` };
  try {
    return { ok: true, event: JSON.parse(body) as unknown };
  } catch {
    return { ok: false, reason: "the body is not JSON" };
  }
}
