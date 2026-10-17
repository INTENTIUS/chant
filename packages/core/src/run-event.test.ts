/**
 * #4019: the run-event contract. One schema for Op, component and pipeline
 * runs, the one writer, and the two older streams mapped onto it. Every
 * line the writer prints is checked against `run-event.schema.json`.
 */

import { describe, expect, test } from "vitest";
import type { RunProgressEvent } from "./components/run-progress";
import type { StepRecord } from "./op/local-executor";
import { contract, validSchema } from "./workspace/__fixtures__/contract-repo";
import { READ_CONTRACT_FLOOR, READ_CONTRACT_VERSION } from "./workspace/reason-codes";
import {
  buildRunEvent,
  createRunEventWriter,
  RUN_EVENT_CONTRACT_VERSION,
  RUN_EVENT_FLOOR,
  RUN_EVENT_SCHEMA_ID,
  RUN_EVENT_TYPES,
  runEventOfProgress,
  runEventsOfStepRecord,
  serializeRunEvent,
  type RunEvent,
  type RunEventBody,
  type RunEventRun,
} from "./run-event";
import schema from "./workspace/run-event.schema.json";

const { validate, expectValid } = contract(schema);

const SHA = "0123456789abcdef0123456789abcdef01234567";

const OP_RUN: RunEventRun = {
  runId: "6f1c2d4e-0000-4000-8000-000000000001",
  kind: "op",
  name: "deploy-api",
  gitSha: SHA,
  runtime: "local",
  runOrigin: { forge: "local" },
};

/** A writer that keeps its lines, on a clock that ticks a second per event. */
function capture(run: RunEventRun) {
  const lines: string[] = [];
  let t = Date.parse("2026-10-16T12:00:00.000Z");
  const writer = createRunEventWriter({ run, write: (l) => lines.push(l), now: () => new Date((t += 1000)), chant: "0.124.28" });
  const events = () => lines.map((l) => JSON.parse(l) as RunEvent);
  return { writer, lines, events };
}

describe("the run-event schema", () => {
  test("is a valid draft 2020-12 document at the contract version, naming its floor and the read contract's", () => {
    expect(validSchema(schema)).toBe(true);
    expect(schema.$id).toBe(RUN_EVENT_SCHEMA_ID);
    expect(RUN_EVENT_SCHEMA_ID).toBe(`https://intentius.io/chant/schemas/workspace/run-event/v${READ_CONTRACT_VERSION}/run-event.schema.json`);
    const envelope = schema.$defs.envelope.properties;
    expect(envelope.contract).toEqual({ const: RUN_EVENT_CONTRACT_VERSION });
    expect(envelope.$schema).toEqual({ const: RUN_EVENT_SCHEMA_ID });
    expect(schema.description).toContain(`written by chant ${RUN_EVENT_FLOOR} and newer`);
    expect(schema.description).toContain(`chant ${READ_CONTRACT_FLOOR} and newer`);
  });

  test("names exactly the event types the code does, and every one requires the envelope", () => {
    const defs = schema.$defs as Record<string, { allOf?: Array<{ $ref?: string; properties?: { type?: { const?: string } } }> }>;
    const refs = schema.oneOf.map((o) => o.$ref.replace("#/$defs/", ""));
    expect([...refs].sort()).toEqual([...RUN_EVENT_TYPES].sort());
    for (const t of RUN_EVENT_TYPES) {
      const parts = defs[t].allOf!;
      expect(parts[0].$ref, t).toBe("#/$defs/envelope");
      expect(parts[1].properties!.type!.const, t).toBe(t);
    }
  });

  test("keeps the step statuses closed, with skipped and room for cached", () => {
    const status = schema.$defs["step-settle"].allOf[1].properties!.status as { enum: string[] };
    expect(status.enum).toEqual(["ok", "failed", "skipped", "cached", "gated", "waiting"]);
    const one = buildRunEvent({ type: "step-settle", component: null, phase: "p", step: "s", status: "ok", durationMs: 1 }, { run: OP_RUN, seq: 3 });
    expectValid(one);
    for (const bad of ["fail", "running", "done"]) expect(validate({ ...one, status: bad }), bad).toBe(false);
    expect(validate({ ...one, status: "skipped", skip: "receipt" })).toBe(true);
    expect(validate({ ...one, status: "skipped", skip: "because" })).toBe(false);
  });

  test("refuses an event missing the run, the commit or the runtime, or at another contract", () => {
    const one = buildRunEvent({ type: "run-start", waves: null }, { run: OP_RUN, seq: 0 });
    expectValid(one);
    for (const field of ["runId", "kind", "name", "gitSha", "runtime", "runOrigin", "seq", "at", "chant"] as const) {
      const copy: Record<string, unknown> = { ...one };
      delete copy[field];
      expect(validate(copy), field).toBe(false);
    }
    expect(validate({ ...one, gitSha: "main" })).toBe(false);
    expect(validate({ ...one, gitSha: null })).toBe(true);
    expect(validate({ ...one, runtime: "cloud" })).toBe(false);
    expect(validate({ ...one, runOrigin: { forge: "jenkins" } })).toBe(false);
    expect(validate({ ...one, contract: 2 })).toBe(false);
    expect(validate({ ...one, type: "run-done" })).toBe(false);
  });

  test("lets a reader ignore fields it does not know", () => {
    expectValid({ ...buildRunEvent({ type: "run-start", waves: null }, { run: OP_RUN, seq: 0 }), later: true });
  });
});

describe("the one writer", () => {
  test("writes an Op run as one line per event, each valid, with the run on every line and seq counting from 0", () => {
    const { writer, lines, events } = capture(OP_RUN);
    const bodies: RunEventBody[] = [
      { type: "run-start", waves: null },
      { type: "phase-start", component: null, phase: "build" },
      { type: "step-start", component: null, phase: "build", step: "shell" },
      { type: "step-settle", component: null, phase: "build", step: "shell", status: "ok", durationMs: 412 },
      { type: "step-start", component: null, phase: "build", step: "effect:schema" },
      { type: "step-settle", component: null, phase: "build", step: "effect:schema", status: "skipped", skip: "receipt", durationMs: 3 },
      { type: "step-settle", component: null, phase: "build", step: "cache-restore", status: "cached", durationMs: 0 },
      { type: "phase-settle", component: null, phase: "build", status: "ok" },
      { type: "phase-start", component: null, phase: "release" },
      { type: "step-start", component: null, phase: "release", step: "gate:prod" },
      { type: "gate-waiting", component: null, phase: "release", step: "gate:prod", op: "deploy-api", gate: "prod", point: null },
      { type: "step-settle", component: null, phase: "release", step: "gate:prod", status: "gated", durationMs: 20 },
      { type: "phase-settle", component: null, phase: "release", status: "gated" },
      { type: "run-settle", status: "gated", durationMs: 1500 },
    ];
    for (const b of bodies) writer.emit(b);
    expect(writer.next).toBe(bodies.length);
    expect(lines.every((l) => l.endsWith("\n") && !l.slice(0, -1).includes("\n"))).toBe(true);
    const evs = events();
    evs.forEach((e, i) => {
      expectValid(e);
      expect(e.seq).toBe(i);
      expect(e).toMatchObject({ $schema: RUN_EVENT_SCHEMA_ID, contract: 1, chant: "0.124.28", runId: OP_RUN.runId, kind: "op", name: "deploy-api", gitSha: SHA, runtime: "local", runOrigin: { forge: "local" } });
      expect(e.type).toBe(bodies[i].type);
    });
    expect(evs[0].at).toBe("2026-10-16T12:00:01.000Z");
    expect(Object.keys(evs[0]).slice(0, 5)).toEqual(["$schema", "contract", "chant", "seq", "at"]);
    expect(evs.at(-1)).toMatchObject({ type: "run-settle", status: "gated" });
  });

  test("writes a pipeline run in forge CI, its stages as phases and its jobs as steps, with the CI locator", () => {
    const { writer, events } = capture({
      runId: "8812345",
      kind: "pipeline",
      name: "main",
      gitSha: SHA,
      runtime: "ci",
      runOrigin: { forge: "gitlab", repo: "acme/api", url: "https://gitlab.example.com/acme/api/-/pipelines/8812345" },
    });
    writer.emit({ type: "run-start", waves: null });
    writer.emit({ type: "phase-start", component: null, phase: "test" });
    writer.emit({ type: "step-start", component: null, phase: "test", step: "unit" });
    writer.emit({ type: "step-settle", component: null, phase: "test", step: "unit", status: "failed", durationMs: 9000, error: "exit 1" });
    writer.emit({ type: "phase-settle", component: null, phase: "test", status: "failed" });
    writer.emit({ type: "run-settle", status: "failed", durationMs: 9100, error: "job unit failed" });
    for (const e of events()) expectValid(e);
  });

  test("writes a steward run with its approval and an open decision point", () => {
    const { writer, events } = capture({ ...OP_RUN, runtime: "steward", runOrigin: { forge: "op", url: "https://fountain.example.com/threads/t-1" } });
    writer.emit({ type: "gate-resolved", component: null, phase: "release", step: "gate:prod", op: "deploy-api", gate: "prod", resolvedBy: "alice", resolvedAt: "2026-10-16T11:00:00.000Z", via: "quorum" });
    writer.emit({ type: "gate-waiting", component: null, phase: "release", step: "pick-region", op: "deploy-api", gate: null, point: "A-0042" });
    writer.emit({ type: "step-settle", component: null, phase: "release", step: "pick-region", status: "waiting", durationMs: 5, message: "region?" });
    writer.emit({ type: "run-settle", status: "waiting", durationMs: 40 });
    for (const e of events()) expectValid(e);
  });

  test("serializes one event as one JSON line", () => {
    const e = buildRunEvent({ type: "run-start", waves: [["a"], ["b", "c"]] }, { run: OP_RUN, seq: 0, at: "2026-10-16T12:00:00.000Z", chant: "1.0.0" });
    expect(serializeRunEvent(e)).toBe(JSON.stringify(e) + "\n");
    expect(e.at).toBe("2026-10-16T12:00:00.000Z");
  });

  test("is exported from @intentius/chant", async () => {
    const root = await import("./index");
    expect(root.createRunEventWriter).toBe(createRunEventWriter);
    expect(root.RUN_EVENT_SCHEMA_ID).toBe(RUN_EVENT_SCHEMA_ID);
  }, 60_000);
});

describe("RunProgressEvent in terms of the run-event contract", () => {
  const progress: RunProgressEvent[] = [
    { type: "run-start", waves: [["db"], ["api", "web"]] },
    { type: "wave-start", wave: 1, components: ["db"] },
    { type: "component-start", wave: 1, component: "db" },
    { type: "phase-start", component: "db", phase: "deploy" },
    { type: "step", component: "db", phase: "deploy", step: "apply", status: "running" },
    { type: "step", component: "db", phase: "deploy", step: "apply", status: "failed", error: "boom" },
    { type: "step", component: "db", phase: "deploy", step: "verify", status: "ok" },
    { type: "phase-done", component: "db", phase: "deploy", status: "failed" },
    { type: "component-done", wave: 1, component: "db", status: "gated" },
    { type: "wave-done", wave: 1, status: "failed" },
    { type: "run-done", status: "failed" },
  ];

  test("maps every variant to a valid event that keeps its fields", () => {
    const { writer, events } = capture({ ...OP_RUN, kind: "component", name: "db,api,web" });
    for (const p of progress) writer.emit(runEventOfProgress(p));
    const evs = events();
    for (const e of evs) expectValid(e);
    expect(evs.map((e) => e.type)).toEqual([
      "run-start",
      "wave-start",
      "component-start",
      "phase-start",
      "step-start",
      "step-settle",
      "step-settle",
      "phase-settle",
      "component-settle",
      "wave-settle",
      "run-settle",
    ]);
    expect(evs[0]).toMatchObject({ waves: [["db"], ["api", "web"]] });
    expect(evs[5]).toMatchObject({ component: "db", step: "apply", status: "failed", error: "boom", durationMs: null });
    expect(evs[8]).toMatchObject({ component: "db", status: "gated" });
  });
});

describe("StepRecord in terms of the run-event contract", () => {
  const ctx = { op: "deploy-api" };
  const base = { phase: "release", args: {}, durationMs: 12 } as const;
  const types = (r: StepRecord) => runEventsOfStepRecord(r, ctx).map((b) => b.type);
  const settle = (r: StepRecord) => runEventsOfStepRecord(r, ctx).at(-1)!;

  test("ok and fail settle ok and failed, with the error", () => {
    expect(settle({ ...base, fn: "shell", status: "ok" })).toEqual({ type: "step-settle", component: null, phase: "release", step: "shell", status: "ok", durationMs: 12 });
    expect(settle({ ...base, fn: "shell", status: "fail", error: "exit 2" })).toMatchObject({ status: "failed", error: "exit 2" });
  });

  test("an approved gate resolves before its step settles ok", () => {
    const r: StepRecord = { ...base, fn: "gate:prod", status: "ok", approval: { gate: "prod", resolvedBy: "alice", timestamp: "2026-10-16T11:00:00.000Z", via: "policy", url: "https://x" } };
    expect(types(r)).toEqual(["gate-resolved", "step-settle"]);
    expect(runEventsOfStepRecord(r, ctx)[0]).toEqual({ type: "gate-resolved", component: null, phase: "release", step: "gate:prod", op: "deploy-api", gate: "prod", resolvedBy: "alice", resolvedAt: "2026-10-16T11:00:00.000Z", via: "policy", url: "https://x" });
  });

  test("a step waiting on a gate or a decision point settles gated or waiting, after gate-waiting", () => {
    const own: StepRecord = { ...base, fn: "workspace-upgrade", status: "skipped", gate: { op: "workspace-upgrade", gate: "all" } };
    expect(types(own)).toEqual(["gate-waiting", "step-settle"]);
    expect(runEventsOfStepRecord(own, ctx)[0]).toMatchObject({ op: "workspace-upgrade", gate: "all", point: null });
    expect(settle(own)).toMatchObject({ status: "gated" });

    const point: StepRecord = { ...base, fn: "pick", status: "skipped", point: { id: "A-1", point: "region", state: "escalated", path: "answers/A-1.md", subject: null, steward: null } };
    expect(runEventsOfStepRecord(point, ctx)[0]).toMatchObject({ type: "gate-waiting", gate: null, point: "A-1" });
    expect(settle(point)).toMatchObject({ status: "waiting" });

    const pointGate: StepRecord = { ...point, fn: "gate:prod" };
    expect(runEventsOfStepRecord(pointGate, ctx)[0]).toMatchObject({ gate: "prod", point: "A-1" });

    const mismatch: StepRecord = { ...base, fn: "gate:prod", status: "skipped", refusal: "approved for another plan" };
    expect(runEventsOfStepRecord(mismatch, ctx)[0]).toMatchObject({ type: "gate-waiting", gate: "prod", message: "approved for another plan" });
    expect(settle(mismatch)).toMatchObject({ status: "gated", message: "approved for another plan" });
  });

  test("skips say why when the record does, and null when it does not", () => {
    expect(settle({ ...base, fn: "build", status: "skipped", resumed: { run: "r-1", gate: "prod" } })).toMatchObject({ status: "skipped", skip: "resumed" });
    expect(settle({ ...base, fn: "workLease:claim", status: "skipped", refusal: "no item ready" })).toMatchObject({ status: "skipped", skip: "refused", message: "no item ready" });
    expect(settle({ ...base, fn: "gate:prod", status: "skipped" })).toMatchObject({ status: "skipped", skip: null });
    expect(settle({ ...base, fn: "migrate", status: "skipped", durationMs: 0 })).toMatchObject({ status: "skipped", skip: null, durationMs: 0 });
  });

  test("every mapped record writes valid events", () => {
    const { writer, events } = capture(OP_RUN);
    const records: StepRecord[] = [
      { ...base, fn: "shell", status: "ok" },
      { ...base, fn: "shell", status: "fail", error: "x" },
      { ...base, fn: "gate:prod", status: "ok", approval: { gate: "prod", resolvedBy: "a", timestamp: "2026-10-16T11:00:00.000Z" } },
      { ...base, fn: "gate:prod", status: "skipped", refusal: "r" },
      { ...base, fn: "build", status: "skipped", resumed: { run: "r-1", gate: "prod" } },
      { ...base, fn: "migrate", status: "skipped" },
    ];
    for (const r of records) for (const b of runEventsOfStepRecord(r, { ...ctx, component: "api" })) writer.emit(b);
    const evs = events();
    expect(evs.length).toBe(8);
    for (const e of evs) {
      expectValid(e);
      expect(e).toMatchObject({ component: "api" });
    }
  });
});
