/**
 * A gated-request ledger in memory, for the state operations' tests
 * (#4762): requests wait until `approve` is called, an approval by the
 * requester is refused as chant's ledger refuses it, and a spent request
 * answers `spent`. Nothing is written to git.
 */
import { gatedRequestDigest, type GatedRequest } from "../lifecycle/gated-request";
import type { GatedRequestLedger } from "../lifecycle/gated-op";

export interface FakeLedger extends GatedRequestLedger {
  approve(by: string): void;
  /** What was written, in order: `pending`, `applied`, `finished:<result>`. */
  writes: string[];
  /** The finished lines' detail, in order. */
  details: Array<Record<string, string | number | boolean>>;
}

export function fakeLedger(): FakeLedger {
  let approvedBy: string | undefined;
  const writes: string[] = [];
  const details: Array<Record<string, string | number | boolean>> = [];
  const asked = new Map<string, { op: string; request: GatedRequest; expiresAt: string }>();
  const spent = new Set<string>();
  return {
    writes,
    details,
    approve(by) {
      approvedBy = by;
    },
    async requestGate(input) {
      const digest = gatedRequestDigest(input.op, input.request);
      if (spent.has(digest)) return { status: "spent", digest, request: input.request };
      if (!asked.has(digest)) {
        asked.set(digest, { op: input.op, request: input.request, expiresAt: "2099-01-01T00:00:00Z" });
        writes.push("pending");
      }
      const command = `chant approve ${input.op} ${input.request.subject} --plan ${digest}`;
      if (!approvedBy) return { status: "waiting", digest, request: input.request, command };
      if (approvedBy === input.request.by) return { status: "refused", digest, request: input.request, by: approvedBy, reason: "the requester's own approval does not count", command };
      return { status: "approved", digest, request: input.request, approval: { version: 1, kind: "resolution", op: input.op, gate: input.request.subject, planDigest: digest, resolvedBy: approvedBy, timestamp: "2026-11-08T10:00:00Z" } as never };
    },
    async spendGatedRequest(input) {
      spent.add(input.digest);
      writes.push("applied");
      return { version: 1, kind: "applied", op: input.op, gate: input.gate, planDigest: input.digest, approvedAt: "", approvedBy: "", timestamp: "2026-11-08T11:00:00Z" } as never;
    },
    async finishGatedRequest(input) {
      writes.push(`finished:${input.result}`);
      details.push(input.detail ?? {});
      return { record: {} as never, pushed: true };
    },
    async readGatedRequests(op) {
      return [...asked.entries()]
        .filter(([, a]) => a.op === op)
        .map(([digest, a]) => ({ op, gate: a.request.subject, digest, request: a.request, pending: { expiresAt: a.expiresAt } as never, approvals: [], ...(spent.has(digest) ? { applied: {} as never } : {}) }));
    },
  };
}
