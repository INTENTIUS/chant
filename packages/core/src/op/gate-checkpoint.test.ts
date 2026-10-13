/**
 * #3947: a run resumes at the approved gate instead of re-running from the
 * first phase. Each test drives the loop through the executor against an
 * in-memory gate ledger: a run stops at the gate and stores a checkpoint, an
 * approval copies its digest, and the next run either picks up at the gate
 * or starts at the first phase and says why.
 */

import { describe, expect, test } from "vitest";
import { runOpLocally, type OpRunResult } from "./local-executor";
import { memoryGateLedgerPort } from "./gate";
import { stepOutput } from "./step-output-ref";
import { activityContract } from "./activity-contract";
import { resumeGatesOf, validateGateResume } from "./gate-checkpoint";
import { renderHuman } from "./local-output";
import { gateCheckpointDigest, gateCheckpointText, parseGateCheckpoint } from "../lifecycle/gate-checkpoint";
import type { ActivityFn } from "./activity-registry";
import type { OpConfig } from "./types";
import { z } from "zod";

const PLAN = `jcs1-sha256:${"a".repeat(64)}`;
const MOVED = `jcs1-sha256:${"b".repeat(64)}`;
const COMMIT = "1".repeat(40);

/**
 * An Op shaped like loomster's upgrade: a snapshot step whose id the apply
 * and the rollback both read, a plan, the gate, then the apply. `noise` runs
 * before the gate and nothing reads it, so the checkpoint leaves it out.
 */
function upgradeOp(gate: Record<string, unknown> = {}): OpConfig {
  return {
    name: "upgrade",
    overview: "upgrade a stack",
    phases: [
      {
        name: "Prepare",
        steps: [
          { kind: "activity", id: "snapshot", fn: "snapshot" },
          { kind: "activity", id: "noise", fn: "noise" },
        ],
      },
      { name: "Plan", steps: [{ kind: "activity", id: "plan", fn: "plan", args: { stack: stepOutput("snapshot", "stack") } }] },
      {
        name: "Gate",
        steps: [{ kind: "gate", gate: "approve-upgrade", plan: stepOutput("plan", "planDigest"), resume: true, ...gate }],
      },
      { name: "Apply", steps: [{ kind: "activity", fn: "apply", args: { snapshot: stepOutput("snapshot", "id") } }] },
    ],
    onFailure: [{ name: "Rollback", steps: [{ kind: "activity", fn: "rollback", args: { to: stepOutput("snapshot", "id") } }] }],
  };
}

/** Activities that count their calls; `plan` returns whatever `digest.value` holds. */
function harness() {
  const calls: Record<string, Array<Record<string, unknown>>> = {};
  const digest = { value: PLAN };
  let snapshots = 0;
  const track = (name: string, fn: ActivityFn): ActivityFn => async (args, signal) => {
    (calls[name] ??= []).push(args);
    return fn(args, signal);
  };
  const activities = new Map<string, ActivityFn>([
    ["snapshot", track("snapshot", async () => ({ id: `snap-${++snapshots}`, stack: "web" }))],
    ["noise", track("noise", async () => ({ big: "x".repeat(10) }))],
    ["plan", track("plan", async () => ({ planDigest: digest.value }))],
    ["apply", track("apply", async () => ({ ok: true }))],
    ["rollback", track("rollback", async () => ({ ok: true }))],
  ]);
  return { calls, digest, activities };
}

const at = (minute: number) => `2026-10-12T12:${String(minute).padStart(2, "0")}:00.000Z`;

async function stopAtGate(config: OpConfig, h: ReturnType<typeof harness>, port = memoryGateLedgerPort()) {
  const first = await runOpLocally(config, h.activities, {}, undefined, { gates: port, now: at(0), runId: "run-1", commit: COMMIT });
  return { port, first };
}

async function approve(port: ReturnType<typeof memoryGateLedgerPort>, first: OpRunResult, over: Record<string, unknown> = {}) {
  await port.appendResolution!({
    op: "upgrade",
    gate: "approve-upgrade",
    resolvedBy: "alex",
    timestamp: at(5),
    planDigest: first.gate!.planDigest!,
    ...(first.gate!.checkpointDigest ? { checkpointDigest: first.gate!.checkpointDigest } : {}),
    ...over,
  });
}

describe("which outputs cross a gate that resumes", () => {
  test("the checkpoint stores what a later step or the rollback reads, and not the plan step or an unread output", () => {
    const [gate] = resumeGatesOf(upgradeOp());
    expect(gate!.name).toBe("approve-upgrade");
    expect(gate!.planStep?.step.id).toBe("plan");
    expect(gate!.stored).toEqual(["snapshot"]);
  });

  test("a gate without resume, or in an Op with a work lease, is not one", () => {
    const plain = upgradeOp({ resume: false });
    expect(resumeGatesOf(plain)).toEqual([]);
    expect(resumeGatesOf({ ...upgradeOp(), workLease: { item: "x" } })).toEqual([]);
  });
});

describe("a run that stops at a gate that resumes", () => {
  test("stores a checkpoint of the crossing outputs and puts its digest on the pending fact", async () => {
    const h = harness();
    const { port, first } = await stopAtGate(upgradeOp(), h);
    expect(first.status).toBe("gated");
    const text = port.checkpoints.get("upgrade/run-1")!;
    const checkpoint = parseGateCheckpoint(text)!;
    expect(checkpoint).toMatchObject({ op: "upgrade", gate: "approve-upgrade", runId: "run-1", commit: COMMIT, planDigest: PLAN });
    expect(checkpoint.outputs).toEqual({ snapshot: { id: "snap-1", stack: "web" } });
    expect(first.gate?.checkpointDigest).toBe(gateCheckpointDigest(checkpoint));

    const lines: string[] = [];
    renderHuman(first, (l) => lines.push(l));
    expect(lines.some((l) => l.includes("resume  :") && l.includes(first.gate!.checkpointDigest!))).toBe(true);
  });

  test("a later run that finds the fact standing writes no second checkpoint", async () => {
    const h = harness();
    const { port } = await stopAtGate(upgradeOp(), h);
    const again = await runOpLocally(upgradeOp(), h.activities, {}, undefined, { gates: port, now: at(1), runId: "run-2", commit: COMMIT });
    expect(again.status).toBe("gated");
    expect(port.appended).toHaveLength(1);
    expect([...port.checkpoints.keys()]).toEqual(["upgrade/run-1"]);
  });

  test("a secret output is never stored, and the run says the gate won't resume", async () => {
    const h = harness();
    const contracts = new Map([["snapshot", activityContract("snapshot", z.object({}), z.object({ id: z.string(), stack: z.string() }), { secret: ["id"] })]]);
    const port = memoryGateLedgerPort();
    const first = await runOpLocally(upgradeOp(), h.activities, {}, undefined, { gates: port, now: at(0), runId: "run-1", commit: COMMIT, contracts });
    expect(first.status).toBe("gated");
    expect(port.checkpoints.size).toBe(0);
    expect(first.gate?.checkpointDigest).toBeUndefined();
    expect(first.resumeNotes?.[0]).toContain(`step "snapshot"'s output "id" is secret`);
  });
});

describe("the run after the approval", () => {
  test("resumes at the gate: re-runs only the plan step, and the apply and rollback read the checkpoint", async () => {
    const h = harness();
    const { port, first } = await stopAtGate(upgradeOp(), h);
    await approve(port, first);

    const second = await runOpLocally(upgradeOp(), h.activities, {}, undefined, { gates: port, now: at(10), runId: "run-2", commit: COMMIT });
    expect(second.status).toBe("ok");
    expect(second.resumed).toEqual({ gate: "approve-upgrade", run: "run-1", checkpoint: first.gate!.checkpointDigest });
    expect(h.calls.snapshot).toHaveLength(1);
    expect(h.calls.noise).toHaveLength(1);
    expect(h.calls.plan).toHaveLength(2);
    expect(h.calls.plan![1]).toEqual({ stack: "web" });
    // The apply got the first run's snapshot, not a fresh one.
    expect(h.calls.apply).toEqual([{ snapshot: "snap-1" }]);

    const snapshot = second.records.find((r) => r.fn === "snapshot");
    expect(snapshot).toMatchObject({ status: "skipped", resumed: { run: "run-1", gate: "approve-upgrade" } });
    expect(second.records.find((r) => r.fn === "gate:approve-upgrade")?.status).toBe("ok");
    expect(second.record.resumed).toEqual(second.resumed);
    expect(second.record.phases[0]?.steps[0]?.resumed).toEqual({ run: "run-1", gate: "approve-upgrade" });

    const lines: string[] = [];
    renderHuman(second, (l) => lines.push(l));
    expect(lines[0]).toContain(`[resume] at gate "approve-upgrade", from run run-1's checkpoint`);
  });

  test("a failure after the resumed gate compensates with the checkpoint's value", async () => {
    const h = harness();
    const { port, first } = await stopAtGate(upgradeOp(), h);
    await approve(port, first);
    h.activities.set("apply", async () => {
      throw new Error("apply failed");
    });
    await expect(
      runOpLocally(upgradeOp(), h.activities, {}, undefined, { gates: port, now: at(10), runId: "run-2", commit: COMMIT }),
    ).rejects.toThrow();
    expect(h.calls.rollback).toEqual([{ to: "snap-1" }]);
  });

  test("starts at the first phase when the plan moved since the approval", async () => {
    const h = harness();
    const { port, first } = await stopAtGate(upgradeOp(), h);
    await approve(port, first);
    h.digest.value = MOVED;

    const second = await runOpLocally(upgradeOp(), h.activities, {}, undefined, { gates: port, now: at(10), runId: "run-2", commit: COMMIT });
    expect(second.status).toBe("gated");
    expect(second.resumed).toBeUndefined();
    expect(second.resumeNotes?.[0]).toContain("the plan moved since the approval");
    expect(h.calls.snapshot).toHaveLength(2);
    expect(h.calls.apply).toBeUndefined();
  });

  test("starts at the first phase at another commit", async () => {
    const h = harness();
    const { port, first } = await stopAtGate(upgradeOp(), h);
    await approve(port, first);

    const second = await runOpLocally(upgradeOp(), h.activities, {}, undefined, { gates: port, now: at(10), runId: "run-2", commit: "2".repeat(40) });
    expect(second.status).toBe("ok");
    expect(second.resumed).toBeUndefined();
    expect(second.resumeNotes?.[0]).toContain("was at commit 111111111111, and this one is at 222222222222");
    expect(h.calls.snapshot).toHaveLength(2);
    expect(h.calls.apply).toEqual([{ snapshot: "snap-2" }]);
  });

  test("starts at the first phase when the checkpoint file changed after the approval", async () => {
    const h = harness();
    const { port, first } = await stopAtGate(upgradeOp(), h);
    await approve(port, first);
    const tampered = parseGateCheckpoint(port.checkpoints.get("upgrade/run-1")!)!;
    tampered.outputs = { snapshot: { id: "snap-evil", stack: "web" } };
    port.checkpoints.set("upgrade/run-1", gateCheckpointText(tampered));

    const second = await runOpLocally(upgradeOp(), h.activities, {}, undefined, { gates: port, now: at(10), runId: "run-2", commit: COMMIT });
    expect(second.resumeNotes?.[0]).toContain("does not match the digest the approver saw");
    expect(h.calls.apply).toEqual([{ snapshot: "snap-2" }]);
  });

  test("starts at the first phase in another environment, or once the pending fact expired", async () => {
    const h = harness();
    const { port, first } = await stopAtGate(upgradeOp(), h);
    await approve(port, first);

    const other = await runOpLocally(upgradeOp(), h.activities, {}, undefined, { gates: port, now: at(10), runId: "run-2", commit: COMMIT, env: "prod" });
    expect(other.resumeNotes?.[0]).toContain("for environment (none), and this one is for prod");

    const late = await runOpLocally(upgradeOp(), h.activities, {}, undefined, { gates: port, now: "2026-10-20T00:00:00.000Z", runId: "run-3", commit: COMMIT });
    expect(late.resumed).toBeUndefined();
    expect(late.resumeNotes?.[0]).toContain("its pending fact expired");
  });

  test("an approval that copied no checkpoint passes the gate the old way, from the first phase", async () => {
    const h = harness();
    const { port, first } = await stopAtGate(upgradeOp(), h);
    await port.appendResolution!({ op: "upgrade", gate: "approve-upgrade", resolvedBy: "alex", timestamp: at(5), planDigest: first.gate!.planDigest! });

    const second = await runOpLocally(upgradeOp(), h.activities, {}, undefined, { gates: port, now: at(10), runId: "run-2", commit: COMMIT });
    expect(second.status).toBe("ok");
    expect(second.resumed).toBeUndefined();
    expect(second.resumeNotes).toBeUndefined();
    expect(h.calls.snapshot).toHaveLength(2);
  });

  test("a gate without resume starts at the first phase as before and stores nothing", async () => {
    const h = harness();
    const port = memoryGateLedgerPort();
    const first = await runOpLocally(upgradeOp({ resume: false }), h.activities, {}, undefined, { gates: port, now: at(0), runId: "run-1", commit: COMMIT });
    expect(first.gate?.checkpointDigest).toBeUndefined();
    expect(port.checkpoints.size).toBe(0);
  });
});

describe("OPS016's check", () => {
  test("a well-placed gate passes", () => {
    expect(validateGateResume(upgradeOp())).toEqual([]);
  });

  test("refuses a resume gate in onFailure, inside an effect, with a decision point, or under a work lease", () => {
    const config = upgradeOp({ point: "prod-apply" });
    config.onFailure = [{ name: "Rollback", steps: [{ kind: "gate", gate: "late", resume: true }] }];
    config.phases.push({
      name: "Effect",
      steps: [{ kind: "effect", receipt: { name: "r" } as never, steps: [{ kind: "gate", gate: "inner", resume: true }] }],
    });
    const messages = validateGateResume({ ...config, workLease: { item: "x" } }).map((i) => i.message);
    expect(messages).toContain("resume is supported only on a gate at the top of a main phase, not in onFailure or inside an effect");
    expect(messages).toContain("a gate can't resume in an Op that runs under a workLease");
    expect(messages).toContain("a gate that asks a decision point can't resume");
  });

  test("refuses a plan step that doesn't run before the gate", () => {
    const config = upgradeOp({ plan: stepOutput("apply-later", "planDigest") });
    expect(validateGateResume(config)[0]?.message).toContain(`its plan names step "apply-later"`);
  });

  test("refuses a secret output read after the gate", () => {
    const contracts = new Map([["snapshot", activityContract("snapshot", z.object({}), z.object({ id: z.string() }), { secret: true })]]);
    expect(validateGateResume(upgradeOp(), contracts)[0]?.message).toContain(`can't resume: step "snapshot"'s output "id" is secret`);
  });
});
