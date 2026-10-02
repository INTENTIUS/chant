/**
 * The run context an activity reads (#2522): the Op, the run id the run
 * ledger records, `--env`, and the gates the run has passed.
 */
import { describe, test, expect } from "vitest";
import type { OpConfig } from "./types";
import type { ActivityFn, ActivityProfile } from "./activity-registry";
import { runOpLocally } from "./local-executor";
import { memoryGateLedgerPort } from "./gate";
import { currentOpRun, type OpRunContext } from "./run-context";
import { gatePolicyVersion, type GatePolicyRef, type ResolvedGateApproval } from "./gate-approval";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";

const PROFILES: Record<string, ActivityProfile> = {
  fastIdempotent: { timeout: "5m", retry: { maximumAttempts: 1 } },
};
const NOW = "2026-09-05T12:00:00.000Z";

function op(steps: OpConfig["phases"][number]["steps"]): OpConfig {
  return { name: "release", overview: "", phases: [{ name: "main", steps }] };
}

describe("the Op run context (#2522)", () => {
  test("an activity reads the Op, the run id and --env", async () => {
    let seen: OpRunContext | undefined;
    const activities = new Map<string, ActivityFn>([
      ["deploy", async () => { await Promise.resolve(); seen = currentOpRun(); }],
    ]);
    const result = await runOpLocally(op([{ kind: "activity", fn: "deploy" }]), activities, PROFILES, undefined, {
      runId: "local-123",
      env: "staging",
    });
    expect(seen).toEqual({ op: "release", runId: "local-123", env: "staging", passedGates: [] });
    expect(result.record?.id).toBe("local-123");
  });

  test("without --env the context carries none, and outside a run there is no context", async () => {
    let seen: OpRunContext | undefined;
    const activities = new Map<string, ActivityFn>([["deploy", async () => { seen = currentOpRun(); }]]);
    await runOpLocally(op([{ kind: "activity", fn: "deploy" }]), activities, PROFILES, undefined, { runId: "r1" });
    expect(seen).toEqual({ op: "release", runId: "r1", passedGates: [] });
    expect(currentOpRun()).toBeUndefined();
  });

  test("a step after a passed gate reads the gate's approval", async () => {
    const seen: OpRunContext[] = [];
    const activities = new Map<string, ActivityFn>([
      ["plan", async () => { seen.push(currentOpRun()!); }],
      ["apply", async () => { seen.push(currentOpRun()!); }],
    ]);
    const port = memoryGateLedgerPort({
      pending: [{
        version: 1, kind: "pending", op: "release", gate: "ship",
        timestamp: "2026-09-05T10:00:00.000Z", expiresAt: "2026-09-07T10:00:00.000Z",
      }],
      resolutions: [{ version: 1, op: "release", gate: "ship", resolvedBy: "alex", timestamp: "2026-09-05T11:00:00.000Z" }],
    });
    const result = await runOpLocally(
      op([
        { kind: "activity", fn: "plan" },
        { kind: "gate", gate: "ship" },
        { kind: "activity", fn: "apply" },
      ]),
      activities,
      PROFILES,
      undefined,
      { gates: port, now: NOW, runId: "r2" },
    );
    expect(result.status).toBe("ok");
    expect(seen[0]!.passedGates).toEqual([]);
    expect(seen[1]!.passedGates).toEqual([
      { gate: "ship", approval: { gate: "ship", resolvedBy: "alex", timestamp: "2026-09-05T11:00:00.000Z" } },
    ]);
    expect(seen[1]!.passedGates[0]!.approval).toEqual(result.records.find((r) => r.fn === "gate:ship")?.approval);
  });

  describe("a policy permit and the gates a run passed (#2512)", () => {
    const TEXT = 'permit (principal is Chant::Agent, action, resource) when { context.risk == "low" };\n';
    const POLICY: GatePolicyRef = { kind: "gate-policy", lexicon: "cedar", name: "ship", version: gatePolicyVersion(TEXT), text: TEXT };
    const enforce: ResolvedGateApproval = { policy: POLICY, mode: "enforce" };
    const permit = (mode: "log-only" | "enforce"): GateResolutionRecord => ({
      version: 1, op: "release", gate: "ship", resolvedBy: "release-bot", timestamp: "2026-09-05T11:00:00.000Z",
      approver: { kind: "agent" },
      policyDecision: { policy: "ship", version: POLICY.version, mode, decision: "allow", determining: ["ship-0"], errors: [] },
    });

    async function run(mode: "log-only" | "enforce") {
      const seen: OpRunContext[] = [];
      const activities = new Map<string, ActivityFn>([["apply", async () => { seen.push(currentOpRun()!); }]]);
      const port = memoryGateLedgerPort({
        pending: [{
          version: 1, kind: "pending", op: "release", gate: "ship",
          timestamp: "2026-09-05T10:00:00.000Z", expiresAt: "2026-09-07T10:00:00.000Z",
          approval: { ...enforce, mode },
        }],
        resolutions: [permit(mode)],
      });
      const result = await runOpLocally(
        op([
          { kind: "gate", gate: "ship", approval: { policy: POLICY, mode: "enforce" } },
          { kind: "activity", fn: "apply" },
        ]),
        activities,
        PROFILES,
        undefined,
        { gates: port, now: NOW, runId: "r3" },
      );
      return { result, seen };
    }

    test("an enforce-mode permit passes the gate, and the next step sees it as passed by policy", async () => {
      const { result, seen } = await run("enforce");
      expect(result.status).toBe("ok");
      expect(seen[0]!.passedGates.map((g) => [g.gate, g.approval.via])).toEqual([["ship", "policy"]]);
    });

    test("a permit recorded under log-only does not pass the enforced gate, so no step sees it as passed", async () => {
      const { result, seen } = await run("log-only");
      expect(result.status).toBe("gated");
      expect(seen).toEqual([]);
      expect(result.records.find((r) => r.fn === "gate:ship")?.approval).toBeUndefined();
    });
  });

  test("two runs in flight at once each see their own context", async () => {
    const seen = new Map<string, string | undefined>();
    const activities = new Map<string, ActivityFn>([
      ["deploy", async () => {
        await new Promise((r) => setTimeout(r, 5));
        const ctx = currentOpRun()!;
        seen.set(ctx.runId, ctx.env);
      }],
    ]);
    const config = op([{ kind: "activity", fn: "deploy" }]);
    await Promise.all([
      runOpLocally(config, activities, PROFILES, undefined, { runId: "a", env: "staging" }),
      runOpLocally(config, activities, PROFILES, undefined, { runId: "b", env: "prod" }),
    ]);
    expect(Object.fromEntries(seen)).toEqual({ a: "staging", b: "prod" });
  });
});
