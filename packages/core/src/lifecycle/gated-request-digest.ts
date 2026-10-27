/**
 * A gated request (#4551): a request for an op that has no wave, such as a
 * state export, a lock release or a standalone migration, approved on the
 * gate ledger like any plan. This module is the pure half, the request's
 * shape and its digest, so it bundles into `@intentius/chant/gate-decision`;
 * the ledger reads and writes are in `./gated-request.ts`.
 */
import { createHash } from "node:crypto";
import { sortedJsonReplacer } from "../utils";

/** One request: what it asks for, of what, by whom and when. */
export interface GatedRequest {
  /** What is asked: `state-export`, `unlock`, `migrate`, or a product's own kind such as `stack-export`. */
  kind: string;
  /** What it is asked of, and the gate it waits at: a root, a stack. */
  subject: string;
  /** The requester. An approval by the requester never counts. */
  by: string;
  /** When it was asked, ISO-8601. */
  at: string;
  /** The request's own facts: a location, a version id, a lock id, a proof digest. All bound by the digest. */
  fields: Record<string, string>;
}

/**
 * The digest a gated request binds: SHA-256 over the canonical JSON (keys
 * sorted) of the op and the request. chant computes it, so every product
 * binds the same fields the same way and `chant approve` can show what an
 * approval covers.
 */
export function gatedRequestDigest(op: string, request: GatedRequest): string {
  const canonical = JSON.stringify({ op, kind: request.kind, subject: request.subject, by: request.by, at: request.at, fields: request.fields }, sortedJsonReplacer);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** `value` as a {@link GatedRequest}, or undefined when it is not one. */
export function gatedRequestOf(value: unknown): GatedRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.kind !== "string" || typeof v.subject !== "string" || typeof v.by !== "string" || typeof v.at !== "string") return undefined;
  const f = v.fields;
  if (typeof f !== "object" || f === null || Array.isArray(f) || !Object.values(f).every((x) => typeof x === "string")) return undefined;
  return { kind: v.kind, subject: v.subject, by: v.by, at: v.at, fields: { ...(f as Record<string, string>) } };
}
