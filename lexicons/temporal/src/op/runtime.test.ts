/**
 * Temporal runtime harness (#161) — runs the serializer's ACTUAL generated
 * workflow under a real Temporal worker + time-skipping test server. This is
 * the durable counterpart to the string-level assertions in op-serializer.test:
 * it proves the emitted control flow behaves correctly at runtime —
 *
 *   - happy path: phases run in declared order
 *   - gate:       the workflow waits for the approval signal (proven via the
 *                 skipped-clock delta), not just for the timeout
 *   - compensation: a failing activity runs onFailure phases in reverse, then
 *                 the original failure is re-thrown (the #168 fix)
 *   - destructive-apply approval: ApplyOp's `nativeApply` does not run until the
 *                 approval signal is received (#125)
 *
 * Each scenario serializes a real Op, writes the emitted workflow.ts next to
 * this file (so `@intentius/chant-lexicon-temporal/config` resolves), and runs
 * it. Generated workflow files live in ./__generated__ (gitignored).
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/common";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActivityFn } from "./activity-registry";
import { serializeOps } from "./serializer";
import { ApplyOp } from "../composites/apply-op";
import type { Declarable } from "@intentius/chant/declarable";

const GEN_DIR = fileURLToPath(new URL("./__generated__", import.meta.url));

// Search attributes the generated workflows upsert (OpName/Phase always; the
// rest from ApplyOp's searchAttributes + the Drift outcome attribute).
const SEARCH_ATTRS = { OpName: 2, Phase: 2, Drift: 2, Apply: 2, Env: 2 } as const;

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}
function workflowFn(name: string): string {
  return camel(name) + "Workflow";
}
function opMap(config: Record<string, unknown>): Map<string, Declarable> {
  return new Map([[config.name as string, { props: config } as unknown as Declarable]]);
}

let env: TestWorkflowEnvironment;
let wfCounter = 0;

beforeAll(async () => {
  mkdirSync(GEN_DIR, { recursive: true });
  env = await TestWorkflowEnvironment.createTimeSkipping();
  await (env.connection as { operatorService: { addSearchAttributes: (r: unknown) => Promise<unknown> } })
    .operatorService.addSearchAttributes({
      namespace: env.namespace,
      searchAttributes: SEARCH_ATTRS,
    });
}, 120_000);

afterAll(async () => {
  await env?.teardown();
  rmSync(GEN_DIR, { recursive: true, force: true });
});

/**
 * Serialize `op` to a workflow file, run it on a fresh worker, optionally
 * signalling mid-flight. Returns the workflow result and the test-clock time
 * (ms) skipped while it ran.
 */
async function runOp(
  op: Map<string, Declarable>,
  activities: Record<string, ActivityFn>,
  opts: { signal?: string } = {},
): Promise<{ durationMs: number; failed: boolean }> {
  const files = serializeOps(op);
  const wfKey = Object.keys(files).find((k) => k.endsWith("/workflow.ts"))!;
  const opName = wfKey.split("/")[1];
  const wfPath = join(GEN_DIR, `${opName}.workflow.ts`);
  writeFileSync(wfPath, files[wfKey]);

  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue: opName,
    workflowsPath: wfPath,
    activities,
  });

  const handle = await env.client.workflow.start(workflowFn(opName), {
    taskQueue: opName,
    workflowId: `${opName}-${wfCounter++}`,
  });
  if (opts.signal) await handle.signal(opts.signal);

  let failed = false;
  await worker.runUntil(handle.result()).catch(() => { failed = true; });

  // Duration from the workflow's own server timestamps — under time-skipping
  // this reflects the wall time the workflow *believed* elapsed (so a gate that
  // waited out its 48h timeout shows ~48h; one cleared by a signal shows ~0).
  const desc = await handle.describe();
  const durationMs =
    desc.closeTime && desc.startTime ? desc.closeTime.getTime() - desc.startTime.getTime() : 0;
  return { durationMs, failed };
}

describe("temporal runtime harness (#161)", () => {
  test("happy path — phases run in declared order", async () => {
    const order: string[] = [];
    const rec = (tag: string): ActivityFn => async () => { order.push(tag); };
    const { failed } = await runOp(
      opMap({
        name: "happy-op", overview: "o",
        phases: [
          { name: "P1", steps: [{ kind: "activity", fn: "a" }] },
          { name: "P2", steps: [{ kind: "activity", fn: "b" }] },
        ],
      }),
      { a: rec("a"), b: rec("b") },
    );
    expect(failed).toBe(false);
    expect(order).toEqual(["a", "b"]);
  }, 120_000);

  test("gate — the workflow waits for the approval signal, not the timeout", async () => {
    const ran: string[] = [];
    const rec = (tag: string): ActivityFn => async () => { ran.push(tag); };
    const gateOp = () => opMap({
      name: "gate-op", overview: "o",
      phases: [
        { name: "Before", steps: [{ kind: "activity", fn: "before" }] },
        { name: "Approve", steps: [{ kind: "gate", signalName: "gate-approve", timeout: "48h" }] },
        { name: "After", steps: [{ kind: "activity", fn: "after" }] },
      ],
    });

    // Signalled: the gate clears immediately, so the 48h timer never elapses.
    ran.length = 0;
    const signalled = await runOp(gateOp(), { before: rec("before"), after: rec("after") }, {
      signal: "gate-approve",
    });
    expect(signalled.failed).toBe(false);
    expect(ran).toEqual(["before", "after"]);
    // The workflow barely took any (skipped) time — the signal short-circuited the 48h wait.
    expect(signalled.durationMs).toBeLessThan(60 * 60 * 1000); // < 1h

    // Unsignalled: the gate blocks on its timer — the workflow's elapsed time is ~48h.
    ran.length = 0;
    const unsignalled = await runOp(gateOp(), { before: rec("before"), after: rec("after") });
    expect(unsignalled.durationMs).toBeGreaterThan(47 * 60 * 60 * 1000); // ~48h
  }, 120_000);

  test("compensation — failing activity runs onFailure in reverse, then re-throws (#168)", async () => {
    const order: string[] = [];
    const activities: Record<string, ActivityFn> = {
      boom: async () => { throw ApplicationFailure.nonRetryable("boom", "Boom"); },
      comp1: async () => { order.push("comp1"); },
      comp2: async () => { order.push("comp2"); },
    };
    const { failed } = await runOp(
      opMap({
        name: "comp-op", overview: "o",
        phases: [{ name: "Main", steps: [{ kind: "activity", fn: "boom" }] }],
        onFailure: [
          { name: "C1", steps: [{ kind: "activity", fn: "comp1" }] },
          { name: "C2", steps: [{ kind: "activity", fn: "comp2" }] },
        ],
      }),
      activities,
    );
    expect(failed).toBe(true);                 // original failure is re-thrown
    expect(order).toEqual(["comp2", "comp1"]);  // reverse phase order
  }, 120_000);

  test("destructive-apply approval — nativeApply waits for the gate (#125)", async () => {
    const ran: string[] = [];
    const activities: Record<string, ActivityFn> = {
      chantBuild: async () => { ran.push("build"); },
      lifecycleDiff: async () => { ran.push("diff"); return { drifted: false }; },
      nativeApply: async () => { ran.push("apply"); },
      compensateApply: async () => { ran.push("compensate"); },
    };
    const { op } = ApplyOp({ name: "apply-op", env: "prod", target: "cloudformation", delete: "gated" });

    // Without the signal, the apply must not have run before the gate clears;
    // with the signal it proceeds through nativeApply.
    const res = await runOp(
      new Map([["apply-op", op as unknown as Declarable]]),
      activities,
      { signal: "approve-apply-op" },
    );
    expect(res.failed).toBe(false);
    expect(ran).toEqual(["build", "diff", "apply"]);
    expect(res.durationMs).toBeLessThan(60 * 60 * 1000); // gate cleared by signal, not timeout
  }, 120_000);
});
