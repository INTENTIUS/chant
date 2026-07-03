/**
 * Component → Temporal runtime harness (#589, epic #551 §5/§8) — the durable
 * counterpart to `../op/runtime.test.ts`, but for component codegen instead
 * of Op codegen. Runs the serializer's ACTUAL generated workflow under a real
 * Temporal worker + time-skipping test server (no live Temporal cluster
 * needed — same technique the Op harness uses), proving:
 *
 *   - happy path: phases run in declared order, wiring threads a prior step's
 *     output into a later step's `@Phase.field` reference
 *   - gate:       the workflow waits for the approval signal (proven via the
 *                 skipped-clock delta), not just for the timeout — mirroring
 *                 the local driver's `DriverGateUnsupportedError` boundary:
 *                 what local mode rejects, Temporal mode runs durably
 *   - compensation: a failing capability step triggers saga rollback (executed
 *                 steps unwound in reverse via their capability's `rollback`)
 *                 AND the component's own `rollback` phases run in reverse,
 *                 before the original failure is re-thrown — matching
 *                 `runComponentDeploy`'s local semantics (driver.ts) exactly
 *
 * Each scenario serializes a real `DriverComponent` via `serializeComponent`,
 * writes the emitted workflow.ts next to this file (so relative imports
 * resolve), and runs it against fake `runCapabilityStep`/`rollbackCapabilityStep`
 * activities — the same "activities are fakes passed to Worker.create, not the
 * real @intentius/chant/components capability registry" approach the Op
 * harness uses for its activities. This proves the GENERATED CONTROL FLOW
 * (phase order, gate wait-for-signal, wiring threading, saga unwind), which is
 * exactly what's specific to this codegen; the capability registry dispatch
 * itself (`runCapabilityStep`'s use of `resolveStepInput` + `CapabilityRegistry`)
 * is already covered by ../../../packages/core/src/components/driver.test.ts
 * (same resolver, same registry, local executor) and capability-plugin.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeComponent, componentWorkflowFnName } from "./serializer";
import type { DriverComponent } from "@intentius/chant/components";

const GEN_DIR = fileURLToPath(new URL("./__generated__", import.meta.url));

// Search attributes the generated workflows upsert (ComponentName/Phase always — see serializer.ts's generateWorkflow).
const SEARCH_ATTRS = { ComponentName: 2, Phase: 2 } as const;

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

/** Fake capability-dispatch activities — records every call, dispatches by `step.kind` to a caller-supplied table. Mirrors component-op/activities.ts's shape without a real CapabilityRegistry. */
type FakeCapabilityRun = (input: Record<string, unknown>) => unknown | Promise<unknown>;
type FakeCapabilityRollback = (input: Record<string, unknown>) => void | Promise<void>;

interface CapabilityStepArgs {
  step: Record<string, unknown>;
  phase: string;
  component: string;
  phaseOutputs: Record<string, Record<string, unknown>>;
  componentOutputs: Record<string, Record<string, unknown>>;
}

function makeFakeActivities(
  runs: Record<string, FakeCapabilityRun>,
  rollbacks: Record<string, FakeCapabilityRollback> = {},
) {
  async function runCapabilityStep(args: CapabilityStepArgs): Promise<unknown> {
    const { kind, ...rest } = args.step;
    const resolvedInput = resolveWiringForTest(rest, args.phaseOutputs, args.componentOutputs);
    const fn = runs[kind as string];
    if (!fn) throw new Error(`no fake capability for kind "${kind as string}"`);
    return fn(resolvedInput);
  }
  async function rollbackCapabilityStep(args: CapabilityStepArgs): Promise<void> {
    const { kind, ...rest } = args.step;
    const resolvedInput = resolveWiringForTest(rest, args.phaseOutputs, args.componentOutputs);
    const fn = rollbacks[kind as string];
    if (fn) await fn(resolvedInput);
  }
  return { runCapabilityStep, rollbackCapabilityStep };
}

/** Minimal `@Phase.field` resolver, mirroring driver.ts's resolveStepInput for this test's fake dispatch (kept self-contained rather than importing core, matching the runtime harness's "activities are fakes" approach). */
function resolveWiringForTest(
  input: Record<string, unknown>,
  phaseOutputs: Record<string, Record<string, unknown>>,
  componentOutputs: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const PRIOR_STEP_REF = /^@([A-Za-z0-9_ ]+)\.([A-Za-z0-9_.]+)$/;
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const m = value.match(PRIOR_STEP_REF);
      if (m) {
        const [, phaseName, field] = m;
        return field.split(".").reduce<unknown>((acc, key) => (acc == null ? acc : (acc as Record<string, unknown>)[key]), phaseOutputs[phaseName]);
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return value;
  };
  void componentOutputs;
  return walk(input) as Record<string, unknown>;
}

/**
 * Serialize `component` to a workflow file, run it on a fresh worker,
 * optionally signalling mid-flight. Returns the workflow result and the
 * test-clock time (ms) skipped while it ran.
 */
async function runComponent(
  component: DriverComponent,
  activities: Record<string, (...args: never[]) => unknown>,
  opts: { signal?: string } = {},
): Promise<{ durationMs: number; failed: boolean }> {
  const files = serializeComponent(component);
  const wfKey = Object.keys(files).find((k) => k.endsWith("/workflow.ts"))!;
  const wfPath = join(GEN_DIR, `${component.name}.workflow.ts`);
  writeFileSync(wfPath, files[wfKey]);

  const taskQueue = `component-${component.name}-${wfCounter}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue,
    workflowsPath: wfPath,
    activities,
  });

  const fnName = componentWorkflowFnName(component.name);
  const handle = await env.client.workflow.start(fnName, {
    taskQueue,
    workflowId: `${component.name}-${wfCounter++}`,
  });
  if (opts.signal) await handle.signal(opts.signal);

  let failed = false;
  await worker.runUntil(handle.result()).catch(() => { failed = true; });

  const desc = await handle.describe();
  const durationMs =
    desc.closeTime && desc.startTime ? desc.closeTime.getTime() - desc.startTime.getTime() : 0;
  return { durationMs, failed };
}

describe("component → Temporal runtime harness (#589)", () => {
  test("happy path — phases run in declared order, wiring threads a prior output", async () => {
    const order: string[] = [];
    const component: DriverComponent = {
      name: "happy-component",
      dependsOn: [],
      deploy: [
        { phase: "Publish", steps: [{ kind: "publish-image" }] },
        { phase: "Apply", steps: [{ kind: "cfn-deploy", imageRef: "@Publish.digest" }] },
      ],
    };
    const { runCapabilityStep, rollbackCapabilityStep } = makeFakeActivities({
      "publish-image": () => { order.push("publish"); return { digest: "sha256:abc123" }; },
      "cfn-deploy": (input) => { order.push(`apply:${input.imageRef as string}`); return { ok: true }; },
    });

    const { failed } = await runComponent(component, { runCapabilityStep, rollbackCapabilityStep });
    expect(failed).toBe(false);
    expect(order).toEqual(["publish", "apply:sha256:abc123"]);
  }, 120_000);

  test("gate — the workflow waits for the approval signal, not the timeout", async () => {
    const ran: string[] = [];
    const makeComponent = (): DriverComponent => ({
      name: "gated-component",
      dependsOn: [],
      deploy: [
        { phase: "Before", steps: [{ kind: "cfn-deploy" }] },
        { phase: "Approve", steps: [{ kind: "gate", signalName: "gate-approve", timeout: "48h" }] },
        { phase: "After", steps: [{ kind: "ecs-update-service" }] },
      ],
    });
    const { runCapabilityStep, rollbackCapabilityStep } = makeFakeActivities({
      "cfn-deploy": () => { ran.push("before"); return {}; },
      "ecs-update-service": () => { ran.push("after"); return {}; },
    });

    // Signalled: the gate clears immediately, so the 48h timer never elapses.
    ran.length = 0;
    const signalled = await runComponent(makeComponent(), { runCapabilityStep, rollbackCapabilityStep }, {
      signal: "gate-approve",
    });
    expect(signalled.failed).toBe(false);
    expect(ran).toEqual(["before", "after"]);
    expect(signalled.durationMs).toBeLessThan(60 * 60 * 1000); // < 1h — signal short-circuited the 48h wait

    // Unsignalled: the gate blocks on its timer — the workflow's elapsed time is ~48h.
    ran.length = 0;
    const unsignalled = await runComponent(makeComponent(), { runCapabilityStep, rollbackCapabilityStep });
    expect(unsignalled.durationMs).toBeGreaterThan(47 * 60 * 60 * 1000); // ~48h
  }, 120_000);

  test("compensation — a failing step triggers saga rollback + component rollback phases in reverse, then re-throws", async () => {
    const order: string[] = [];
    const component: DriverComponent = {
      name: "comp-component",
      dependsOn: [],
      deploy: [
        { phase: "Publish", steps: [{ kind: "publish-image" }] },
        { phase: "Apply", steps: [{ kind: "cfn-deploy" }] },
      ],
      rollback: [
        { phase: "Undo1", steps: [{ kind: "cdn-invalidate" }] },
        { phase: "Undo2", steps: [{ kind: "wait-for-stack" }] },
      ],
    };
    const { runCapabilityStep, rollbackCapabilityStep } = makeFakeActivities(
      {
        "publish-image": () => { order.push("publish"); return { digest: "sha256:1" }; },
        "cfn-deploy": () => { throw new Error("boom"); },
        "cdn-invalidate": () => { order.push("undo1"); return {}; },
        "wait-for-stack": () => { order.push("undo2"); return {}; },
      },
      {
        "publish-image": () => { order.push("rollback:publish-image"); },
      },
    );

    const { failed } = await runComponent(component, { runCapabilityStep, rollbackCapabilityStep });
    expect(failed).toBe(true); // original failure is re-thrown
    // Saga unwind (executed steps, reverse order) then component rollback phases (reverse order).
    expect(order).toEqual(["publish", "rollback:publish-image", "undo2", "undo1"]);
  }, 120_000);

  test("parallel phase — every concurrent step's output survives the merge into phaseOutputs", async () => {
    // Regression test: the generated workflow used to write each parallel
    // branch's output straight into phaseOutputs[phase] as soon as that
    // branch's own await resolved, so two concurrent branches could race on
    // the same read-merge-write and silently drop one branch's contribution.
    // The fix collects every branch's output via Promise.all first, then
    // merges all of them into phaseOutputs in one pass — this test proves a
    // later step can see BOTH parallel branches' fields, not just whichever
    // branch happened to finish (and write) last.
    const seen: Record<string, unknown>[] = [];
    const component: DriverComponent = {
      name: "parallel-component",
      dependsOn: [],
      deploy: [
        {
          phase: "Fanout",
          parallel: true,
          steps: [
            { kind: "publish-image" },
            { kind: "publish-artifact" },
          ],
        },
        {
          phase: "Apply",
          steps: [{ kind: "cfn-deploy", imageDigest: "@Fanout.digest", artifactKey: "@Fanout.key" }],
        },
      ],
    };
    const { runCapabilityStep, rollbackCapabilityStep } = makeFakeActivities({
      // publish-artifact resolves after a tick, publish-image resolves immediately —
      // so without the fix, publish-artifact's write would win the race and
      // publish-image's `digest` field would be lost from phaseOutputs.Fanout.
      "publish-image": () => ({ digest: "sha256:img" }),
      "publish-artifact": async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { key: "s3://bucket/artifact" };
      },
      "cfn-deploy": (input) => { seen.push(input); return {}; },
    });

    const { failed } = await runComponent(component, { runCapabilityStep, rollbackCapabilityStep });
    expect(failed).toBe(false);
    expect(seen).toEqual([{ imageDigest: "sha256:img", artifactKey: "s3://bucket/artifact" }]);
  }, 120_000);
});
