/**
 * #4035: what a partly applied run records, and how a mixed environment is
 * derived from it and the release ledger. Pure; nothing is read or written.
 */

import { describe, expect, test } from "vitest";
import { deployOutcomeOf, parseDeployOutcomes, type DeployOutcome } from "./deploy-outcome";
import { mixedEnvironment, rollbackTarget, unsettledComponents, type ReleaseCheck } from "./mixed-environment";
import type { ReleaseRecord } from "./release-ledger";
import type { PromotionPlan } from "../components/promote";

const R1 = `jcs1-sha256:${"1".repeat(64)}`;
const R2 = `jcs1-sha256:${"2".repeat(64)}`;
const R3 = `jcs1-sha256:${"3".repeat(64)}`;

const rec = (component: string, timestamp: string, releaseDigest?: string): ReleaseRecord => ({
  version: 1, component, env: "prod", digest: `sha256:${component}-${releaseDigest?.slice(12, 13) ?? "x"}`, gitSha: "abc", runId: "r", timestamp, actor: "ci",
  ...(releaseDigest ? { releaseDigest } : {}),
});

const plan: PromotionPlan = {
  from: "staging",
  to: "prod",
  items: ["api", "web"].map((component) => ({ component, digest: `sha256:${component}`, source: rec(component, "2026-01-01T00:00:00.000Z") })),
  notPromoted: [],
};

const outcome = (timestamp: string, components: DeployOutcome["components"], releaseDigest: string | null = R2): DeployOutcome => ({
  version: 1, env: "prod", verb: "promote", runId: "run-9", timestamp, actor: "bob", releaseDigest, status: "fail", components,
});

const all = async (): Promise<ReleaseCheck> => ({ kept: true, revoked: false });
const labels: Record<string, string> = { [R1]: "v1", [R2]: "v2", [R3]: "v3" };
const label = async (d: string) => labels[d];

describe("deployOutcomeOf", () => {
  const run = (statuses: Array<"ok" | "fail" | "gated" | undefined>, status: "ok" | "fail" | "gated") => ({
    status,
    results: statuses.flatMap((s, i) => (s ? [{ component: plan.items[i].component, ok: s === "ok", status: s, records: [] }] : [])),
  });
  const of = (r: ReturnType<typeof run>) => deployOutcomeOf({ verb: "promote", plan, run: r, releaseDigest: R2, runId: "run-9", timestamp: "t", actor: "bob" });

  test("records a run that deployed some components and not others, or failed", () => {
    expect(of(run(["ok", "fail"], "fail"))?.components.map((c) => [c.component, c.outcome, c.releaseDigest])).toEqual([["api", "deployed", R2], ["web", "failed", R2]]);
    expect(of(run(["fail", undefined], "fail"))?.components.map((c) => c.outcome)).toEqual(["failed", "not-run"]);
    expect(of(run(["ok", "gated"], "gated"))?.status).toBe("gated");
  });

  test("records nothing for a run that deployed everything, or stopped at a gate before deploying anything", () => {
    expect(of(run(["ok", "ok"], "ok"))).toBeNull();
    expect(of(run(["gated", undefined], "gated"))).toBeNull();
  });
});

describe("parseDeployOutcomes", () => {
  test("skips a line that is not an outcome", () => {
    const good = JSON.stringify(outcome("t", [{ component: "api", outcome: "failed", digest: "sha256:a", releaseDigest: null }]));
    expect(parseDeployOutcomes(`${good}\nnot json\n{"version":1}\n`)).toMatchObject({ outcomes: [{ runId: "run-9" }], malformed: 2 });
  });
});

describe("mixed environments", () => {
  test("a failed component stays unsettled until the ledger records it after the run", () => {
    const o = outcome("2026-01-02T00:00:00.000Z", [{ component: "api", outcome: "deployed", digest: "sha256:a", releaseDigest: R2 }, { component: "web", outcome: "failed", digest: "sha256:w", releaseDigest: R2 }]);
    const records = [rec("api", "2026-01-01T00:00:00.000Z", R1), rec("web", "2026-01-01T00:00:00.000Z", R1), rec("api", "2026-01-02T00:00:00.000Z", R2)];
    expect([...unsettledComponents(records, [o]).keys()]).toEqual(["web"]);
    expect(unsettledComponents([...records, rec("web", "2026-01-03T00:00:00.000Z", R1)], [o]).size).toBe(0);
  });

  test("components on different releases are mixed, a record of no release counting as one; no release at all is not", async () => {
    const mixed = await mixedEnvironment({ env: "prod", records: [rec("api", "2026-01-02T00:00:00.000Z", R2), rec("web", "2026-01-01T00:00:00.000Z")], outcomes: [], label, check: all });
    expect(mixed?.components.map((c) => [c.component, c.releaseLabel, c.state])).toEqual([["api", "v2", "settled"], ["web", null, "settled"]]);
    expect(mixed?.rollback).toBeNull();
    expect(await mixedEnvironment({ env: "prod", records: [rec("api", "t1"), rec("web", "t1")], outcomes: [], label, check: all })).toBeNull();
    expect(await mixedEnvironment({ env: "prod", records: [rec("api", "t1", R1), rec("web", "t1", R1)], outcomes: [], label, check: all })).toBeNull();
  });

  test("a run that failed before deploying anything leaves the environment mixed, and the rollback goes back past the release it tried", async () => {
    const records = [rec("api", "2026-01-01T00:00:00.000Z", R1), rec("api", "2026-01-02T00:00:00.000Z", R2)];
    const o = outcome("2026-01-03T00:00:00.000Z", [{ component: "api", outcome: "failed", digest: "sha256:a3", releaseDigest: R3 }], R3);
    const mixed = await mixedEnvironment({ env: "prod", records, outcomes: [o], label, check: all });
    expect(mixed).toMatchObject({
      components: [{ component: "api", releaseLabel: "v2", state: "failed", attempt: { releaseLabel: "v3" } }],
      redeploy: ["chant components redeploy prod --component api"],
      rollback: "chant components rollback prod --release v2",
    });
  });

  test("the rollback target skips a revoked release and one that is no longer kept, and honours before", async () => {
    const records = [rec("api", "2026-01-01T00:00:00.000Z", R1), rec("api", "2026-01-02T00:00:00.000Z", R2), rec("api", "2026-01-03T00:00:00.000Z", R3)];
    const check = async (d: string): Promise<ReleaseCheck> => ({ kept: d !== R2, revoked: false });
    expect(await rollbackTarget({ records, exclude: new Set([R3]), check })).toBe(R1);
    expect(await rollbackTarget({ records, exclude: new Set(), check: async (d) => ({ kept: true, revoked: d === R3 }) })).toBe(R2);
    expect(await rollbackTarget({ records, exclude: new Set(), before: "2026-01-02T00:00:00.000Z", check: all })).toBe(R1);
    expect(await rollbackTarget({ records, exclude: new Set([R1, R2, R3]), check: all })).toBeNull();
  });
});
