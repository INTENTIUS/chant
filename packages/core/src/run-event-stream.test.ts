/**
 * #4041: the emitters' side of the run-event contract. The stream holds a
 * run to the shape the schema promises, the older `--progress-json` lines
 * come back unchanged from the bodies the driver now emits, and a run is
 * named by the commit and CI run #4020 resolves.
 */

import { describe, expect, test } from "vitest";
import type { RunProgressEvent } from "./components/run-progress";
import { memoryGateLedgerPort, type GateCheck } from "./op/gate";
import type { RunEventBody, RunEventRun } from "./run-event";
import {
  emitGateStep,
  gateEventsOf,
  joinRunEventSinks,
  openRunEventStream,
  progressOfRunEvent,
  progressSinkOf,
  resolveRunEventRun,
  runEventRunOf,
} from "./run-event-stream";
import { checkRunEventLines } from "./workspace/__fixtures__/run-event-check";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const RUN: RunEventRun = { runId: "local-1", kind: "component", name: "api", gitSha: SHA, runtime: "local", runOrigin: { forge: "local" } };

function capture(run: RunEventRun = RUN) {
  const lines: string[] = [];
  let t = Date.parse("2026-10-16T12:00:00.000Z");
  const stream = openRunEventStream(run, (l) => lines.push(l), { now: () => new Date((t += 1000)), chant: "0.124.28" });
  return { stream, lines };
}

describe("openRunEventStream", () => {
  test("opens with run-start, drops a second one, times run-settle, and writes nothing after it", () => {
    const { stream, lines } = capture();
    stream.emit({ type: "run-start", waves: [["api"]] });
    stream.emit({ type: "run-start", waves: [["other"]] });
    stream.emit({ type: "phase-start", component: "api", phase: "Apply" });
    stream.emit({ type: "phase-settle", component: "api", phase: "Apply", status: "ok" });
    stream.emit({ type: "run-settle", status: "ok", durationMs: null });
    stream.emit({ type: "phase-start", component: "api", phase: "late" });
    stream.settle("failed", "too late");
    const events = checkRunEventLines(lines);
    expect(events.map((e) => e.type)).toEqual(["run-start", "phase-start", "phase-settle", "run-settle"]);
    expect(events[0]).toMatchObject({ waves: [["api"]] });
    // Untimed by the emitter, so the stream timed it from run-start.
    expect(events.at(-1)).toMatchObject({ status: "ok", durationMs: expect.any(Number) });
    expect((events.at(-1) as { durationMs: number }).durationMs).toBeGreaterThan(0);
    expect(stream.settled).toBe(true);
  });

  test("a stream whose emitter never said run-start still opens with one, and settle ends it with the error", () => {
    const { stream, lines } = capture();
    stream.emit({ type: "step-start", component: null, phase: "Build", step: "make", index: 0 });
    stream.emit({ type: "step-settle", component: null, phase: "Build", step: "make", index: 0, status: "failed", durationMs: 5, error: "boom" });
    stream.settle("failed", "boom");
    const events = checkRunEventLines(lines);
    expect(events[0]).toMatchObject({ type: "run-start", waves: null });
    expect(events.at(-1)).toMatchObject({ type: "run-settle", status: "failed", error: "boom" });
  });

  test("nested drops the inner run's framing, so the outer run settles it", () => {
    const { stream, lines } = capture();
    stream.emit({ type: "run-start", waves: [["a"]] });
    stream.nested({ type: "run-start", waves: [["a"]] });
    stream.nested({ type: "wave-start", wave: 1, components: ["a"] });
    stream.nested({ type: "wave-settle", wave: 1, status: "ok" });
    stream.nested({ type: "run-settle", status: "ok", durationMs: null });
    expect(stream.settled).toBe(false);
    stream.settle("gated");
    expect(checkRunEventLines(lines).map((e) => e.type)).toEqual(["run-start", "wave-start", "wave-settle", "run-settle"]);
  });
});

describe("progressOfRunEvent: --progress-json keeps its shape", () => {
  test("each body the driver emits maps back to the RunProgressEvent it replaced, key order and all", () => {
    const pairs: Array<[RunEventBody, RunProgressEvent]> = [
      [{ type: "run-start", waves: [["a"]] }, { type: "run-start", waves: [["a"]] }],
      [{ type: "wave-start", wave: 1, components: ["a"] }, { type: "wave-start", wave: 1, components: ["a"] }],
      [{ type: "component-start", wave: 1, component: "a" }, { type: "component-start", wave: 1, component: "a" }],
      [{ type: "phase-start", component: "a", phase: "Apply" }, { type: "phase-start", component: "a", phase: "Apply" }],
      [{ type: "step-start", component: "a", phase: "Apply", step: "apply", index: 0 }, { type: "step", component: "a", phase: "Apply", step: "apply", status: "running" }],
      [
        { type: "step-settle", component: "a", phase: "Apply", step: "apply", index: 0, status: "failed", durationMs: 4, error: "no" },
        { type: "step", component: "a", phase: "Apply", step: "apply", status: "failed", error: "no" },
      ],
      [{ type: "phase-settle", component: "a", phase: "Apply", status: "gated" }, { type: "phase-done", component: "a", phase: "Apply", status: "gated" }],
      [{ type: "component-settle", wave: 1, component: "a", status: "failed" }, { type: "component-done", wave: 1, component: "a", status: "failed" }],
      [{ type: "wave-settle", wave: 1, status: "ok" }, { type: "wave-done", wave: 1, status: "ok" }],
      [{ type: "run-settle", status: "ok", durationMs: 12 }, { type: "run-done", status: "ok" }],
    ];
    for (const [body, old] of pairs) expect(JSON.stringify(progressOfRunEvent(body))).toBe(JSON.stringify(old));
  });

  test("what the older stream never printed maps to nothing: gate steps, skipped steps, gate decisions, phases outside a component", () => {
    const none: RunEventBody[] = [
      { type: "step-start", component: "a", phase: "Apply", step: "gate:prod", index: 0 },
      { type: "step-settle", component: "a", phase: "Apply", step: "gate:prod", index: 0, status: "gated", durationMs: 1 },
      { type: "step-settle", component: "a", phase: "Apply", step: "apply", index: 1, status: "skipped", skip: "not-run", durationMs: null },
      { type: "gate-waiting", component: "a", phase: "Apply", step: "gate:prod", op: "a", gate: "prod", point: null },
      { type: "phase-start", component: null, phase: "gate" },
      { type: "phase-settle", component: null, phase: "gate", status: "ok" },
    ];
    for (const body of none) expect(progressOfRunEvent(body)).toBeUndefined();
  });

  test("progressSinkOf and joinRunEventSinks hand each body to every sink, and to none when none is given", () => {
    const old: RunProgressEvent[] = [];
    const bodies: RunEventBody[] = [];
    const sink = joinRunEventSinks((b) => bodies.push(b), progressSinkOf((e) => old.push(e)), undefined)!;
    sink({ type: "run-start", waves: [] });
    sink({ type: "gate-waiting", component: null, phase: "gate", step: "gate:g", op: "fan-out", gate: "g", point: null });
    expect(bodies).toHaveLength(2);
    expect(old).toEqual([{ type: "run-start", waves: [] }]);
    expect(joinRunEventSinks(undefined, progressSinkOf(undefined))).toBeUndefined();
  });
});

describe("a gate's decision as events", () => {
  const at = { component: null, phase: "gate", step: "gate:pr-apply", op: "pr-12", gate: "pr-apply" };

  test("approved: gate-resolved and an ok settle; not approved: gate-waiting and a gated settle", () => {
    const approved: GateCheck = {
      satisfied: true,
      resolution: { version: 1, kind: "resolution", op: "pr-12", gate: "pr-apply", resolvedBy: "github:alice", timestamp: "2026-10-16T11:00:00.000Z" },
    } as GateCheck;
    expect(gateEventsOf(approved, at, { durationMs: 3 })).toEqual([
      { type: "gate-resolved", component: null, phase: "gate", step: "gate:pr-apply", op: "pr-12", gate: "pr-apply", resolvedBy: "github:alice", resolvedAt: "2026-10-16T11:00:00.000Z", via: null },
      { type: "step-settle", component: null, phase: "gate", step: "gate:pr-apply", status: "ok", durationMs: 3 },
    ]);
  });

  test("emitGateStep frames the decision as a gate phase, schema-valid, start before settle", async () => {
    const { stream, lines } = capture();
    const port = memoryGateLedgerPort();
    const check = await emitGateStep(stream.emit, { op: "fan-out", gate: "ship" }, () =>
      import("./op/gate").then((g) => g.evaluateGate(port, { op: "fan-out", gate: "ship", now: "2026-10-16T12:00:00.000Z" })),
    );
    expect(check.satisfied).toBe(false);
    stream.settle("gated");
    const events = checkRunEventLines(lines);
    expect(events.map((e) => e.type)).toEqual(["run-start", "phase-start", "step-start", "gate-waiting", "step-settle", "phase-settle", "run-settle"]);
    expect(events[4]).toMatchObject({ status: "gated", step: "gate:ship" });
  });
});

describe("a run's identity (#4020's sources)", () => {
  test("outside CI: a local id, the local origin and the local runtime", async () => {
    const run = await resolveRunEventRun({ kind: "component", name: "api", cwd: "/nonexistent", env: {} });
    expect(run).toMatchObject({ kind: "component", name: "api", gitSha: null, runtime: "local", runOrigin: { forge: "local" } });
    expect(run.runId).toMatch(/^local-\d+$/);
  });

  test("in a GitHub job: the CI run's id and origin, the commit the job is for, and the ci runtime", async () => {
    const env = { GITHUB_RUN_ID: "77", GITHUB_REPOSITORY: "acme/app", GITHUB_SERVER_URL: "https://github.com", GITHUB_SHA: SHA };
    const run = await resolveRunEventRun({ kind: "component", name: "api", cwd: "/nonexistent", env });
    expect(run).toEqual({
      runId: "77",
      kind: "component",
      name: "api",
      gitSha: SHA,
      runtime: "ci",
      runOrigin: { forge: "github", repo: "acme/app", url: "https://github.com/acme/app/actions/runs/77" },
    });
    // An id of the caller's own, not the CI run's, lives in no CI id space.
    expect((await resolveRunEventRun({ kind: "component", name: "api", runId: "run-9", cwd: "/nonexistent", env })).runOrigin).toEqual({ forge: "local" });
  });

  test("a steward's run is the op id space on the steward runtime", () => {
    expect(runEventRunOf({ kind: "op", name: "deploy", runId: "conv-1", steward: true })).toEqual({
      runId: "conv-1", kind: "op", name: "deploy", gitSha: null, runtime: "steward", runOrigin: { forge: "op" },
    });
  });
});
