/**
 * The one content digest chant computes itself (chant #2514).
 *
 * `contentDigest(x)` is `"sha256:"` followed by the lowercase hex SHA-256 of
 * the UTF-8 bytes of `x`. Anything core hashes goes through it, and anything
 * structured is first put in canonical form with `canonicalJson`
 * (./effect-receipt.ts), so the same value always hashes the same way. The
 * build archive re-exports it from ./components/verbs/build-archive.ts, where
 * it used to live.
 *
 * Before #2514 this function computed a 32-bit string hash and repeated its
 * eight hex digits eight times. Values recorded then are recognised and
 * flagged by ./lifecycle/legacy-digest.ts.
 */

import { createHash } from "node:crypto";

/** `sha256:<64 hex>` over the UTF-8 bytes of `input`. */
export function contentDigest(input: string): string {
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

/** Lowercase hex SHA-256 of `bytes`, with no prefix: the form a decision's evidence pin holds (#2549). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
