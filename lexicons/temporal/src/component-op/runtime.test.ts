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
 *                 `runComponentDeploy`'s local semantics (driver.ts) exactly.
 *                 Also (#1944, epic #1564 phase 4): each rolled-back step's
 *                 rollback receives its own run()'s output — the durable
 *                 identity channel a capability needs when it cannot rely on
 *                 in-process object identity across this workflow's separate
 *                 run/rollback Activity invocations — and a rollback failure
 *                 is logged and recorded into a `RollbackFailed` search
 *                 attribute instead of silently vanishing.
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
import {
  accumulateComponentOutputs as accumulateComponentOutputsCore,
  resolveStepInput,
  type DriverComponent,
} from "@intentius/chant/components";

const GEN_DIR = fileURLToPath(new URL("./__generated__", import.meta.url));

// Search attributes the generated workflows upsert (ComponentName/Phase always,
// RollbackFailed only on a saga-unwind failure, #1944 — see serializer.ts's
// generateWorkflow/renderRollback).
const SEARCH_ATTRS = { ComponentName: 2, Phase: 2, RollbackFailed: 7 } as const;

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
/** `output` is the durable identity channel (#1944): the same value this step's own fake `run()` returned, threaded through by the generated workflow's `executed` array — see activities.ts's `CapabilityStepArgs.output` doc comment. */
type FakeCapabilityRollback = (input: Record<string, unknown>, output?: unknown) => void | Promise<void>;

interface CapabilityStepArgs {
  step: Record<string, unknown>;
  phase: string;
  component: string;
  phaseOutputs: Record<string, Record<string, unknown>>;
  componentOutputs: Record<string, Record<string, unknown>>;
  output?: unknown;
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
    if (fn) await fn(resolvedInput, args.output);
  }
  // The accumulator is NOT faked: it is the real core function behind the real
  // activity (component-op/activities.ts), so this harness proves the durable
  // path captures outputs exactly as driver.ts does (#700 parity).
  async function accumulateComponentOutputs(args: {
    component: string;
    phaseOutputs: Record<string, Record<string, unknown>>;
    componentOutputs: Record<string, Record<string, unknown>>;
  }): Promise<Record<string, Record<string, unknown>>> {
    return accumulateComponentOutputsCore({ ...args.componentOutputs }, args.component, args.phaseOutputs);
  }
  return { runCapabilityStep, rollbackCapabilityStep, accumulateComponentOutputs };
}

/** Like `makeFakeActivities`, but resolving wiring through core's real `resolveStepInput` — so `stackOutput()` / `@<component>.publish.*` references resolve exactly as activities.ts does (the cross-stack test needs the componentOutputs branch, which the minimal resolver below deliberately ignores). */
function makeFakeActivitiesWithCoreResolver(runs: Record<string, FakeCapabilityRun>) {
  const base = makeFakeActivities(runs);
  async function runCapabilityStep(args: CapabilityStepArgs): Promise<unknown> {
    const { kind, ...rest } = args.step;
    const resolvedInput = resolveStepInput(rest, args.phaseOutputs, args.componentOutputs);
    const fn = runs[kind as string];
    if (!fn) throw new Error(`no fake capability for kind "${kind as string}"`);
    return fn(resolvedInput);
  }
  return { ...base, runCapabilityStep };
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
  opts: { signal?: string; seed?: Record<string, Record<string, unknown>> } = {},
): Promise<{
  durationMs: number;
  failed: boolean;
  result?: { phaseOutputs: Record<string, Record<string, unknown>>; componentOutputs: Record<string, Record<string, unknown>> };
  searchAttributes: Record<string, unknown>;
}> {
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
    args: opts.seed ? [{ componentOutputs: opts.seed }] : [],
  });
  if (opts.signal) await handle.signal(opts.signal);

  let failed = false;
  let result: { phaseOutputs: Record<string, Record<string, unknown>>; componentOutputs: Record<string, Record<string, unknown>> } | undefined;
  await worker.runUntil(handle.result()).then((r) => { result = r as typeof result; }).catch(() => { failed = true; });

  const desc = await handle.describe();
  const durationMs =
    desc.closeTime && desc.startTime ? desc.closeTime.getTime() - desc.startTime.getTime() : 0;
  return { durationMs, failed, result, searchAttributes: desc.searchAttributes };
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
    const activities = makeFakeActivities({
      "publish-image": () => { order.push("publish"); return { digest: "sha256:abc123" }; },
      "cfn-deploy": (input) => { order.push(`apply:${input.imageRef as string}`); return { ok: true }; },
    });

    const { failed, result } = await runComponent(component, activities);
    expect(failed).toBe(false);
    expect(order).toEqual(["publish", "apply:sha256:abc123"]);
    // (#597) the workflow returns its final phaseOutputs so the CLI can read the
    // published digest via handle.result() and auto-emit a release record.
    expect(result?.phaseOutputs.Publish).toEqual({ digest: "sha256:abc123" });
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
    const activities = makeFakeActivities({
      "cfn-deploy": () => { ran.push("before"); return {}; },
      "ecs-update-service": () => { ran.push("after"); return {}; },
    });

    // Signalled: the gate clears immediately, so the 48h timer never elapses.
    ran.length = 0;
    const signalled = await runComponent(makeComponent(), activities, {
      signal: "gate-approve",
    });
    expect(signalled.failed).toBe(false);
    expect(ran).toEqual(["before", "after"]);
    expect(signalled.durationMs).toBeLessThan(60 * 60 * 1000); // < 1h — signal short-circuited the 48h wait

    // Unsignalled: the gate blocks on its timer — the workflow's elapsed time is ~48h.
    ran.length = 0;
    const unsignalled = await runComponent(makeComponent(), activities);
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
    const activities = makeFakeActivities(
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

    const { failed } = await runComponent(component, activities);
    expect(failed).toBe(true); // original failure is re-thrown
    // Saga unwind (executed steps, reverse order) then component rollback phases (reverse order).
    expect(order).toEqual(["publish", "rollback:publish-image", "undo2", "undo1"]);
  }, 120_000);

  // ── #1944: durable identity channel — output threaded to rollback ─────────

  test("compensation — a rolled-back step's rollback receives the exact output its own run() returned (#1944 durable identity channel)", async () => {
    // This is the gap the epic #1564 phase-4 scope addition (on #1949's
    // review) flagged: run() and rollback() execute as separate Activities on
    // this durable path, each rebuilding resolvedInput fresh from JSON — no
    // in-process object identity survives between them the way it does for
    // driver.ts's local saga unwind. A capability like run-agent
    // (@intentius/chant/components/verbs/run-agent) that recorded state in a
    // WeakMap keyed by run()'s exact input object therefore never got a hit
    // here. This test proves the fix: the generated workflow now carries each
    // step's own run() output alongside it (serializer.ts's `executed`
    // array) and passes it through rollbackCapabilityStep's `output` field
    // (activities.ts) as `Capability.rollback`'s third parameter.
    const receivedOutputs: unknown[] = [];
    const component: DriverComponent = {
      name: "identity-component",
      dependsOn: [],
      deploy: [
        { phase: "Provision", steps: [{ kind: "run-agent-like" }] },
        { phase: "Apply", steps: [{ kind: "cfn-deploy" }] },
      ],
    };
    const activities = makeFakeActivities(
      {
        // Mirrors RunAgentOutput's shape: run() records identity (spriteId/
        // checkpointId) only in its OWN output, never anywhere rollback()
        // could reach it without this channel.
        "run-agent-like": () => ({ spriteId: "sprite-abc", checkpointId: "chk-1" }),
        "cfn-deploy": () => { throw new Error("boom"); },
      },
      {
        "run-agent-like": (_input, output) => { receivedOutputs.push(output); },
      },
    );

    const { failed } = await runComponent(component, activities);
    expect(failed).toBe(true);
    // The rollback fake received exactly what run() returned — not undefined,
    // not the resolved input, not a stale/rebuilt object.
    expect(receivedOutputs).toEqual([{ spriteId: "sprite-abc", checkpointId: "chk-1" }]);
  }, 120_000);

  test("compensation — a rollback failure is logged and surfaced via the RollbackFailed search attribute, not silently swallowed (#1944)", async () => {
    // Before #1944 the generated workflow's saga-unwind catch was bare
    // (`catch { /* ... */ }`) — a genuine rollback failure (the sprite
    // backend erroring, say) vanished with zero logging or observable trace.
    const component: DriverComponent = {
      name: "loud-degrade-component",
      dependsOn: [],
      deploy: [
        { phase: "Provision", steps: [{ kind: "provision-step" }] },
        { phase: "Apply", steps: [{ kind: "cfn-deploy" }] },
      ],
    };
    const activities = makeFakeActivities(
      {
        "provision-step": () => ({ ok: true }),
        "cfn-deploy": () => { throw new Error("apply boom"); },
      },
      {
        "provision-step": () => { throw new Error("rollback also failed"); },
      },
    );

    const { failed, searchAttributes } = await runComponent(component, activities);
    expect(failed).toBe(true); // the ORIGINAL failure still terminates the workflow
    const rollbackFailed = (searchAttributes.RollbackFailed as string[] | undefined) ?? [];
    expect(rollbackFailed.length).toBeGreaterThan(0);
    const parsed = rollbackFailed.map((s) => JSON.parse(s));
    expect(parsed).toEqual([
      expect.objectContaining({ kind: "provision-step", phase: "Provision", error: expect.stringContaining("rollback also failed") }),
    ]);
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
    const activities = makeFakeActivities({
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

    const { failed } = await runComponent(component, activities);
    expect(failed).toBe(false);
    expect(seen).toEqual([{ imageDigest: "sha256:img", artifactKey: "s3://bucket/artifact" }]);
  }, 120_000);
  test("cross-stack — a cfn-deploy's outputs accumulate under the component name and feed a downstream stackOutput() through the seeded workflow (#700)", async () => {
    // Durable mirror of driver.test.ts's "feeds a deployed stack's outputs to a
    // downstream component's stackOutput references" (#699). Two workflows
    // stand in for a parent orchestration: shared-alb runs first and its
    // result.componentOutputs (built by the REAL core accumulator) seeds api,
    // whose steps resolve stackOutput() through the REAL core resolver.
    const sharedAlb: DriverComponent = {
      name: "shared-alb",
      dependsOn: [],
      deploy: [
        { phase: "Publish", steps: [{ kind: "publish-image" }] },
        { phase: "Apply", steps: [{ kind: "cfn-deploy", stack: "shared-alb", template: "shared-alb.json" }] },
      ],
    };
    const api: DriverComponent = {
      name: "api",
      dependsOn: ["shared-alb"],
      deploy: [
        { phase: "Publish", steps: [{ kind: "publish-image", from: "archive:api.tar", to: { stackOutput: { stack: "shared-alb", name: "ApiRepoUri" } } }] },
        { phase: "Verify", steps: [{ kind: "wait-steady-state", service: "api", cluster: { stackOutput: { stack: "shared-alb", name: "ClusterArn" } }, base: "@shared-alb.publish.digest" }] },
      ],
    };

    const seenPublish: Record<string, unknown>[] = [];
    const seenVerify: Record<string, unknown>[] = [];
    const activities = makeFakeActivitiesWithCoreResolver({
      "publish-image": (input) => { seenPublish.push(input); return { uri: "repo@sha256:abc", digest: "sha256:abc" }; },
      "cfn-deploy": () => ({
        stackStatus: "CREATE_COMPLETE",
        outputs: {
          ApiRepoUri: "123.dkr.ecr.us-east-1.amazonaws.com/alb-api",
          ClusterArn: "arn:aws:ecs:us-east-1:123:cluster/shared",
        },
      }),
      "wait-steady-state": (input) => { seenVerify.push(input); return { ok: true }; },
    });

    const upstream = await runComponent(sharedAlb, activities);
    expect(upstream.failed).toBe(false);
    // Stack outputs at the top level (peer to `publish`), keyed by the component
    // name — the same shape runInterpretDriver exposes locally.
    expect(upstream.result?.componentOutputs).toEqual({
      "shared-alb": {
        ApiRepoUri: "123.dkr.ecr.us-east-1.amazonaws.com/alb-api",
        ClusterArn: "arn:aws:ecs:us-east-1:123:cluster/shared",
        publish: { uri: "repo@sha256:abc", digest: "sha256:abc" },
      },
    });

    const downstream = await runComponent(api, activities, { seed: upstream.result!.componentOutputs });
    expect(downstream.failed).toBe(false);
    expect(seenPublish.at(-1)).toMatchObject({ to: "123.dkr.ecr.us-east-1.amazonaws.com/alb-api" });
    expect(seenVerify.at(-1)).toMatchObject({ cluster: "arn:aws:ecs:us-east-1:123:cluster/shared", base: "sha256:abc" });
    // The seed survives and api's own outputs are added beside it, so a parent
    // can keep threading the same map to the next component workflow.
    expect(Object.keys(downstream.result!.componentOutputs).sort()).toEqual(["api", "shared-alb"]);
    expect(downstream.result!.componentOutputs.api).toEqual({ publish: { uri: "repo@sha256:abc", digest: "sha256:abc" } });
  }, 120_000);
});
