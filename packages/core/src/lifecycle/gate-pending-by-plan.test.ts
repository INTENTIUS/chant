/**
 * Pending gates by plan digest (#4607): the standing facts a digest finds,
 * and the pull request a `pr-<n>[-<member>]` op names.
 */

import { describe, expect, test } from "vitest";
import { pullRequestOfOp, standingPendingByPlan } from "./gate-pending-by-plan";
import type { GateResolutionRecord, PendingGateRecord } from "./gate-ledger";

const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const NOW = "2026-10-27T12:00:00.000Z";

function pending(over: Partial<PendingGateRecord> = {}): PendingGateRecord {
  return { version: 1, kind: "pending", op: "pr-12", gate: "up", timestamp: "2026-10-27T10:00:00.000Z", expiresAt: "2026-10-28T10:00:00.000Z", planDigest: D1, ...over } as PendingGateRecord;
}

function resolution(over: Partial<GateResolutionRecord> = {}): GateResolutionRecord {
  return { version: 1, kind: "resolution", op: "pr-12", gate: "up", timestamp: "2026-10-27T11:00:00.000Z", resolution: "approved", planDigest: D1, ...over } as unknown as GateResolutionRecord;
}

describe("pullRequestOfOp", () => {
  test("pr-<n> and pr-<n>-<member> name the pull request; other ops none", () => {
    expect(pullRequestOfOp("pr-12")).toEqual({ pr: 12 });
    expect(pullRequestOfOp("pr-12-network")).toEqual({ pr: 12, member: "network" });
    expect(pullRequestOfOp("pulumi-up")).toBeUndefined();
    expect(pullRequestOfOp("pr-abc")).toBeUndefined();
  });
});

describe("standingPendingByPlan", () => {
  test("a standing fact with the digest names its op, gate and pull request", () => {
    const found = standingPendingByPlan({ pending: [pending()], resolutions: [] }, D1, NOW);
    expect(found).toEqual([expect.objectContaining({ op: "pr-12", gate: "up", pr: 12, matched: "planDigest", planDigest: D1 })]);
    expect(standingPendingByPlan({ pending: [pending({ op: "pr-12-network" })], resolutions: [] }, D1, NOW)[0]).toMatchObject({ pr: 12, member: "network" });
  });

  test("the digest matches whichever prefix it carries", () => {
    expect(standingPendingByPlan({ pending: [pending()], resolutions: [] }, "1".repeat(64).replace(/^/, "sha256:"), NOW)).toHaveLength(1);
  });

  test("a wave fact's change set matches too", () => {
    const wave = pending({ op: "pulumi-up", gate: "wave-2", planDigest: D2, changeSet: D1 });
    expect(standingPendingByPlan({ pending: [wave], resolutions: [] }, D1, NOW)).toEqual([expect.objectContaining({ op: "pulumi-up", gate: "wave-2", matched: "changeSet" })]);
    expect(standingPendingByPlan({ pending: [wave], resolutions: [] }, D1, NOW)[0]!.pr).toBeUndefined();
  });

  test("another digest, an expired fact, an answered fact, or a newer fact for another plan finds nothing", () => {
    expect(standingPendingByPlan({ pending: [pending()], resolutions: [] }, D2, NOW)).toEqual([]);
    expect(standingPendingByPlan({ pending: [pending({ expiresAt: "2026-10-27T11:00:00.000Z" })], resolutions: [] }, D1, NOW)).toEqual([]);
    expect(standingPendingByPlan({ pending: [pending()], resolutions: [resolution()] }, D1, NOW)).toEqual([]);
    const moved = pending({ timestamp: "2026-10-27T11:30:00.000Z", planDigest: D2 });
    expect(standingPendingByPlan({ pending: [pending(), moved], resolutions: [] }, D1, NOW)).toEqual([]);
  });

  test("a resolution older than the fact, or for another environment, leaves it standing", () => {
    const older = resolution({ timestamp: "2026-10-27T09:00:00.000Z" });
    expect(standingPendingByPlan({ pending: [pending()], resolutions: [older] }, D1, NOW)).toHaveLength(1);
    const prod = pending({ environment: "prod" });
    const staging = resolution({ environment: "staging" } as Partial<GateResolutionRecord>);
    expect(standingPendingByPlan({ pending: [prod], resolutions: [staging] }, D1, NOW)).toEqual([expect.objectContaining({ environment: "prod" })]);
  });

  test("facts per environment stand side by side, newest first", () => {
    const staging = pending({ environment: "staging", timestamp: "2026-10-27T10:00:00.000Z" });
    const prod = pending({ environment: "prod", timestamp: "2026-10-27T10:30:00.000Z" });
    expect(standingPendingByPlan({ pending: [staging, prod], resolutions: [] }, D1, NOW).map((g) => g.environment)).toEqual(["prod", "staging"]);
  });
});
