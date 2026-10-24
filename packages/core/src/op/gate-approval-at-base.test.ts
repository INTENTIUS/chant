/**
 * #4404: an Op gate's `policy`, `mode` and `context` are fields of
 * `identity.gates.<gate>` in the workspace declaration at base, as the quorum
 * is (#4324), so a change can't switch its own gate to `log-only` or swap in a
 * permissive policy and be judged by that.
 */

import { afterEach, describe, expect, test } from "vitest";
import type { GateStep, OpConfig } from "./types";
import type { ActivityFn } from "./activity-registry";
import { resolveGateApproval, runOpLocally } from "./local-executor";
import { gitGateLedgerPort, memoryGateLedgerPort, type GateLedgerPort } from "./gate";
import { gatePolicyVersion, type GatePolicyRef } from "./gate-approval";
import { stepOutput } from "./step-output-ref";
import { resetGateOrigin } from "../lifecycle/gate-origin";
import { hasSshKeygen, TestRepo } from "../workspace/trust/test-repo";

const policy = (name: string, text: string): GatePolicyRef => ({ kind: "gate-policy", lexicon: "cedar", name, version: gatePolicyVersion(text), text });
const STRICT = policy("strict", "forbid unless maintainer");
const PERMISSIVE = policy("permissive", "permit all");

const step = (approval?: GateStep["approval"]): GateStep => ({ kind: "gate", gate: "ship", ...(approval ? { approval } : {}) }) as GateStep;

describe("resolveGateApproval reads policy, mode and context at base (#4404)", () => {
  test("the base policy and mode replace the Op's own", () => {
    const opSide = step({ policy: PERMISSIVE, mode: "log-only" });
    const got = resolveGateApproval(opSide, new Map(), undefined, null, { policy: STRICT, mode: "enforce" });
    expect(got).toEqual({ policy: STRICT, mode: "enforce" });
  });

  test("a gate whose Op dropped its approval block still takes the base policy and mode", () => {
    expect(resolveGateApproval(step(), new Map(), undefined, null, { policy: STRICT, mode: "enforce" })).toEqual({ policy: STRICT, mode: "enforce" });
  });

  test("a field the entry leaves out comes from the Op", () => {
    const opSide = step({ policy: PERMISSIVE, mode: "enforce" });
    expect(resolveGateApproval(opSide, new Map(), undefined, null, { mode: "log-only" })).toEqual({ policy: PERMISSIVE, mode: "log-only" });
    expect(resolveGateApproval(opSide, new Map(), undefined, null, { policy: STRICT })).toEqual({ policy: STRICT, mode: "enforce" });
  });

  test("the base context wins key by key, and a key only the Op sets still reaches the policy", () => {
    const opSide = step({ policy: STRICT, context: { risk: "low", team: "payments" } });
    const got = resolveGateApproval(opSide, new Map(), undefined, null, { context: { risk: "high" } });
    expect(got?.context).toEqual({ risk: "high", team: "payments" });
  });

  test("a step output reference in the Op's context still resolves beside a base key", () => {
    const opSide = step({ policy: STRICT, context: { rows: stepOutput("verify", "rows") } });
    const got = resolveGateApproval(opSide, new Map([["verify", { rows: 12 }]]), undefined, null, { context: { risk: "high" } });
    expect(got?.context).toEqual({ risk: "high", rows: 12 });
  });

  test("with nothing at base, the Op's own applies", () => {
    expect(resolveGateApproval(step({ policy: PERMISSIVE, mode: "enforce" }), new Map(), undefined, null, { policy: null, mode: null, context: null })).toEqual({ policy: PERMISSIVE, mode: "enforce" });
    expect(resolveGateApproval(step(), new Map(), undefined, null, { policy: null, mode: null, context: null })).toBeUndefined();
  });
});

describe.skipIf(!hasSshKeygen)("an Op gate's policy and mode at base (#4404)", () => {
  const repos: TestRepo[] = [];
  afterEach(() => {
    resetGateOrigin();
    while (repos.length) repos.pop()!.cleanup();
  });

  const declaration = (gate: Record<string, unknown>): string => JSON.stringify({ name: "acme", schema: 1, members: [], identity: { gates: { ship: gate } } });
  const config = (approval: NonNullable<GateStep["approval"]>): OpConfig => ({
    name: "release",
    overview: "",
    phases: [
      { name: "Gate", steps: [{ kind: "gate", gate: "ship", approval }] },
      { name: "Apply", steps: [{ kind: "activity", fn: "ship", args: {} }] },
    ],
  });
  const activities = new Map<string, ActivityFn>([["ship", async () => ({})]]);

  test("a change that switches its gate to a permissive log-only policy is judged by the base's", async () => {
    const r = new TestRepo("4404-policy");
    repos.push(r);
    r.git(["config", "user.email", "t@example.test"]);
    r.git(["config", "user.name", "t"]);
    r.git(["config", "commit.gpgsign", "false"]);
    r.write("chant.workspace.json", declaration({ policy: STRICT, mode: "enforce", context: { risk: "high" } }));
    r.commit("base");
    // The pull request rewrites the declaration's entry too; only base counts.
    r.git(["checkout", "-q", "-b", "loosen"]);
    r.write("chant.workspace.json", declaration({ policy: PERMISSIVE, mode: "log-only", context: { risk: "low" } }));
    r.commit("loosen the gate");

    const git = gitGateLedgerPort({ cwd: r.dir });
    const gates: GateLedgerPort = { ...memoryGateLedgerPort(), approvalRule: git.approvalRule };
    // The Op the change builds says permissive, log-only and low risk.
    const run = await runOpLocally(config({ policy: PERMISSIVE, mode: "log-only", context: { risk: "low" } }), activities, {}, undefined, { gates, now: "2026-10-23T12:00:00.000Z" });
    expect(run.status).toBe("gated");
    expect(run.gate?.approval).toMatchObject({ policy: STRICT, mode: "enforce", context: { risk: "high" } });
  });
});
