/**
 * A gated deploy leaves four records that name each other (#4020): the run
 * record, the pending gate fact, the resolution and the release record. From
 * any one of them, the other three are one lookup away, by the commit sha, the
 * run id or the gate.
 */
import { describe, test, expect, afterEach, vi } from "vitest";
import type { ActivityFn, ActivityProfile } from "./activity-registry";
import type { OpConfig } from "./types";
import { runOpLocally } from "./local-executor";
import { memoryGateLedgerPort } from "./gate";
import { resolveGateRunLocator, runOriginOfLocator } from "./gate-run-locator";
import { admissionOf, resolveRunId, type ReleaseRecord } from "../lifecycle/release-ledger";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";

const SHA = "c0ffee".repeat(6) + "c0ff";
const PROFILES: Record<string, ActivityProfile> = { single: { timeout: "5m", retry: { maximumAttempts: 1 } } };
const NOW = "2026-10-16T10:00:00.000Z";
const CI = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "acme/app",
  GITHUB_RUN_ID: "9001",
  GITHUB_SERVER_URL: "https://github.example",
  GITHUB_API_URL: "https://github.example/api/v3",
};

afterEach(() => vi.unstubAllEnvs());

const config: OpConfig = {
  name: "ship",
  overview: "",
  labels: { Env: "prod" },
  phases: [
    { name: "Build", steps: [{ kind: "activity", fn: "build" }] },
    { name: "Release", steps: [{ kind: "gate", gate: "approve-release" }, { kind: "activity", fn: "release" }] },
  ],
};
const activities = new Map<string, ActivityFn>([
  ["build", async () => undefined],
  ["release", async () => undefined],
]);

describe("a gated deploy: commit, run, gate and deploy record join (#4020)", () => {
  test("each record names the commit, and the run, gate and deploy name one another", async () => {
    for (const [k, v] of Object.entries(CI)) vi.stubEnv(k, v);
    const port = memoryGateLedgerPort();

    // 1. The run reaches the gate and stops. Its record and the pending fact carry the commit.
    const first = await runOpLocally(config, activities, PROFILES, undefined, { gates: port, now: NOW, commit: SHA });
    expect(first.status).toBe("gated");
    const run = first.record;
    const pending = port.appended[0]!;
    expect(run.gitSha).toBe(SHA);
    expect(run.runOrigin).toEqual({ forge: "github", repo: "acme/app", url: "https://github.example/acme/app/actions/runs/9001" });
    expect(pending.gitSha).toBe(SHA);
    expect(pending.runId).toBe(run.id);

    // 2. Someone approves. `chant approve` copies the commit and run off the pending fact it answers.
    const resolution: GateResolutionRecord = {
      version: 1, op: pending.op, gate: pending.gate, resolvedBy: "alice", timestamp: "2026-10-16T10:05:00.000Z",
      gitSha: pending.gitSha, runId: pending.runId,
    };
    const second = await runOpLocally(config, activities, PROFILES, undefined, {
      gates: memoryGateLedgerPort({ pending: [pending], resolutions: [resolution] }),
      now: "2026-10-16T10:06:00.000Z",
      commit: SHA,
    });
    expect(second.status).toBe("ok");

    // 3. The release activity records the deploy, naming the gate that admitted it.
    const admitted = admissionOf([resolution], { op: "ship", gate: "approve-release" })!;
    const ci = resolveRunId();
    const release: ReleaseRecord = {
      version: 1, component: "site", env: "prod", digest: `sha256:${"d".repeat(64)}`, gitSha: SHA,
      runId: ci.runId, runOrigin: ci.runOrigin, timestamp: "2026-10-16T10:07:00.000Z", actor: "ci",
      approver: admitted.approver, admission: admitted.admission,
    };

    // From the commit: the run, the gate and the deploy.
    const byCommit = {
      runs: [run, second.record].filter((r) => r.gitSha === SHA),
      pending: port.appended.filter((p) => p.gitSha === SHA),
      resolutions: [resolution].filter((r) => r.gitSha === SHA),
      releases: [release].filter((r) => r.gitSha === SHA),
    };
    expect(byCommit.runs.map((r) => r.id)).toContain(run.id);
    expect(byCommit.pending).toEqual([pending]);
    expect(byCommit.resolutions).toEqual([resolution]);
    expect(byCommit.releases).toEqual([release]);

    // From the run: its gate, by run id, and the CI run it ran in.
    expect(run.gate).toMatchObject({ name: pending.gate });
    expect(resolution.runId).toBe(run.id);
    expect(pending.runId).toBe(run.id);

    // From the deploy: the gate resolution that admitted it, the approver, and the CI run the run was in.
    expect(release.admission).toEqual({ op: pending.op, gate: pending.gate, resolvedAt: resolution.timestamp });
    expect(release.approver).toBe(resolution.resolvedBy);
    expect(release.runOrigin).toEqual(run.runOrigin);
    expect(release.runId).toBe(runOriginOfLocator(resolveGateRunLocator()!).runId);
    expect(release.gitSha).toBe(run.gitSha);
  });

  test("a run outside CI records its commit and no run origin", async () => {
    for (const k of ["GITHUB_RUN_ID", "CI_PIPELINE_ID"]) vi.stubEnv(k, "");
    const result = await runOpLocally(config, activities, PROFILES, undefined, { gates: memoryGateLedgerPort(), now: NOW, commit: SHA });
    expect(result.record.gitSha).toBe(SHA);
    expect(result.record).not.toHaveProperty("runOrigin");
  });

  test("admissionOf names the newest of several approvals and joins their approvers", () => {
    const at = (resolvedBy: string, timestamp: string): GateResolutionRecord => ({ version: 1, op: "ship", gate: "g", resolvedBy, timestamp, planDigest: "p" });
    expect(admissionOf([at("a", "2026-01-01T00:00:00Z"), at("b", "2026-01-02T00:00:00Z"), at("a", "2026-01-03T00:00:00Z")], { op: "ship", gate: "g", planDigest: "p" }))
      .toEqual({ approver: "a, b", admission: { op: "ship", gate: "g", resolvedAt: "2026-01-03T00:00:00Z" } });
    expect(admissionOf([at("a", "2026-01-01T00:00:00Z")], { op: "ship", gate: "g", planDigest: "other" })).toBeUndefined();
  });
});
