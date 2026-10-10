/**
 * #3712: a `chant lifecycle diff` that fails yields no digest, so an approval
 * cannot pass a gate for a plan nobody read.
 *
 * Before the fix the activity caught the diff's non-zero exit and digested
 * its error output. Every run whose build failed printed the same lines, so
 * an approval of one such run's digest matched the next, whatever the
 * declarations had become, and the Apply phase (which builds on its own)
 * applied the change.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

/** What the next `chant lifecycle diff` prints and how it exits. */
const next = { stdout: "", stderr: "", code: 0 };

vi.mock(import("node:child_process"), async (importOriginal) => ({
  ...(await importOriginal()),
  exec: ((_command: string, _options: unknown, callback: (err: unknown, out?: { stdout: string; stderr: string }) => void) => {
    if (next.code === 0) callback(null, { stdout: next.stdout, stderr: next.stderr });
    else callback(Object.assign(new Error("exit"), { code: next.code, stdout: next.stdout, stderr: next.stderr }));
  }) as never,
}));

const { lifecycleDiff, lifecycleDiffDigest } = await import("./lifecycle");
const { OpRunFailure, runOpLocally } = await import("../local-executor");
const { stepOutput } = await import("../step-output-ref");
type ActivityFn = import("../activity-registry").ActivityFn;
type ActivityProfile = import("../activity-registry").ActivityProfile;
type GateLedgerPort = import("../gate").GateLedgerPort;
type GateResolutionRecord = import("../../lifecycle/gate-ledger").GateResolutionRecord;
type PendingGateRecord = import("../../lifecycle/gate-ledger").PendingGateRecord;
type OpConfig = import("../types").OpConfig;

const PROFILES: Record<string, ActivityProfile> = {
  fastIdempotent: { timeout: "5m", retry: { maximumAttempts: 1 } },
};

const BUILD_FAILED = "error: Build failed for project — fix errors before diffing";
const ARGS = { env: "dev", live: true };

function failDiff(): void {
  Object.assign(next, { stdout: "", stderr: BUILD_FAILED, code: 1 });
}

function diffPrints(render: string): void {
  Object.assign(next, { stdout: render, stderr: "", code: 0 });
}

beforeEach(() => {
  diffPrints("");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("lifecycleDiff on a failed diff (#3712)", () => {
  test("a build error rejects, naming the command and the error, with no digest", async () => {
    failDiff();
    await expect(lifecycleDiff(ARGS)).rejects.toThrow(/chant lifecycle diff dev --live failed \(exit 1\); no plan to digest:\n.*Build failed for project/);
  });

  test("a diff that succeeds still returns its digest", async () => {
    diffPrints("MISSING (declared, provider reports not in cloud):\n  - events");
    const result = await lifecycleDiff(ARGS);
    expect(result.exitCode).toBe(0);
    expect(result.drifted).toBe(true);
    expect(result.planDigest).toBe(lifecycleDiffDigest(ARGS, "MISSING (declared, provider reports not in cloud):\n  - events"));
  });
});

describe("ApplyOp's gate over a diff whose build fails (#3712)", () => {
  function ledger(): GateLedgerPort & { approve(planDigest: string): void } {
    const resolutions: GateResolutionRecord[] = [];
    const pending: PendingGateRecord[] = [];
    return {
      approve(planDigest) {
        resolutions.push({ version: 1, op: "apply-dev", gate: "approve-apply-dev", resolvedBy: "alex", timestamp: "2026-10-10T12:05:00.000Z", planDigest });
      },
      async read() {
        return { resolutions: [...resolutions], pending: [...pending] };
      },
      async appendPending(input) {
        const record: PendingGateRecord = { version: 1, kind: "pending", ...input };
        pending.push(record);
        return { record, pushed: true };
      },
    };
  }

  const statuses = (failure: unknown) =>
    (failure as InstanceType<typeof OpRunFailure>).result.records.map((r) => [r.fn, r.status]);

  /** ApplyOp's Plan, Approve and Apply phases, with the real `lifecycleDiff` and an apply that records what it applied. */
  function harness() {
    const declared = { schema: "A" };
    const applied: string[] = [];
    const activities = new Map<string, ActivityFn>([
      ["lifecycleDiff", (args, signal) => lifecycleDiff(args as { env: string; live?: boolean }, signal)],
      ["nativeApply", async () => {
        applied.push(declared.schema);
      }],
    ]);
    const config: OpConfig = {
      name: "apply-dev",
      overview: "",
      phases: [
        { name: "Plan", steps: [{ kind: "activity", fn: "lifecycleDiff", id: "plan", args: ARGS }] },
        { name: "Approve", steps: [{ kind: "gate", gate: "approve-apply-dev", plan: stepOutput("plan", "planDigest") }] },
        { name: "Apply", steps: [{ kind: "activity", fn: "nativeApply" }] },
      ],
    };
    return { declared, applied, activities, config };
  }

  test("an approval of plan A does not pass for plan B when the diff's build fails both times", async () => {
    const { declared, applied, activities, config } = harness();
    const gates = ledger();

    // Plan A: the diff's build fails. The run stops at Plan: nothing reaches the gate.
    failDiff();
    const first = await runOpLocally(config, activities, PROFILES, undefined, { gates, now: "2026-10-10T12:00:00.000Z" }).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(OpRunFailure);
    expect(statuses(first)).toEqual([["lifecycleDiff", "fail"]]);
    expect(applied).toEqual([]);

    // The digest the diff's error output used to give: someone approves it.
    gates.approve(lifecycleDiffDigest(ARGS, BUILD_FAILED));

    // Plan B: the declarations change, and the diff's build still fails.
    declared.schema = "B";
    const second = await runOpLocally(config, activities, PROFILES, undefined, { gates, now: "2026-10-10T12:10:00.000Z" }).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(OpRunFailure);
    expect(statuses(second)).toEqual([["lifecycleDiff", "fail"]]);
    expect(applied).toEqual([]);
  });

  test("with the build fixed, the run stops at the gate for the plan it read", async () => {
    const { applied, activities, config } = harness();
    const gates = ledger();
    const render = "MISSING (declared, provider reports not in cloud):\n  - events";
    diffPrints(render);
    const run = await runOpLocally(config, activities, PROFILES, undefined, { gates, now: "2026-10-10T12:00:00.000Z" });
    expect(run.status).toBe("gated");
    expect(run.gate?.planDigest).toBe(lifecycleDiffDigest(ARGS, render));
    expect(applied).toEqual([]);
  });
});
