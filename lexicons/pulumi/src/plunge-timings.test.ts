/**
 * plunge's per-resource timings (INTENTIUS/plunge#55) in run records and
 * traces (INTENTIUS/chant#4579).
 *
 * The engine is a fake answering with `testdata/pulumi-stream` (the corpus
 * stream; see its README), with `metadata.plungeTimings` added to the
 * resources the update changed, in the shape plunge#55 prints. The trace goes
 * to a fake collector on 127.0.0.1. No pulumi or plunge binary runs here, and
 * nothing reaches a backend or a real endpoint.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CapabilityRegistry, type Capability } from "@intentius/chant/components/capability";
import { createOtlpExporter, otlpFromEnv } from "@intentius/chant/otlp";
import { memoryGateLedgerPort } from "@intentius/chant/op/gate";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { runOpWave, type OpWaveShowAtBase } from "@intentius/chant/op/op-waves-run";
import type { OpRunRecordInput } from "@intentius/chant/op/runtime";
import { plungeTimingOf, pulumiStreamSummary, pulumiStreamTimings, type PlungeTiming } from "./engine-events";
import { plungeResourceSpan, plungeTimingSpans, plungeTimingTotals, pulumiUrnParts } from "./plunge-timings";
import { createPulumiUpCapability } from "./pulumi-up";
import type { PulumiRunner } from "./run";
import { pulumiTraceFacts } from "./trace-facts";

const testdata = join(import.meta.dirname, "testdata");
const dir = join(testdata, "pulumi-preview");
const stream = readFileSync(join(testdata, "pulumi-stream", "preview-stream.ndjson"), "utf-8");
const upStream = stream.replaceAll(',"planning":true', "");
const stackOutput = readFileSync(join(testdata, "pulumi-outputs", "stack-output.json"), "utf-8");
const urn = (type: string, name: string) => `urn:pulumi:floci::corpus-aws-ts::${type}::${name}`;

const at = (ms: number) => new Date(Date.parse("2026-10-27T12:00:00.000Z") + ms).toISOString().replace("Z", "123Z");

/** plunge#55's entries for one changed resource: its provider calls, then its record write. */
const timingsFor = (op: string, offset: number): PlungeTiming[] => [
  { kind: "provider", call: "diff", startedAt: at(offset), durationMs: 3.5 },
  { kind: "provider", call: op === "delete" ? "delete" : op === "replace" ? "create" : "update", startedAt: at(offset + 10), durationMs: 812.4 },
  { kind: "record", call: op === "delete" ? "delete" : "write", startedAt: at(offset + 830), durationMs: 21.25 },
];

/** The corpus `up` stream as plunge prints it: every changed resource's outputs event carries its timings. */
function plungeUpStream(): { text: string; timed: string[] } {
  const timed: string[] = [];
  const lines = upStream.split("\n").map((line, i) => {
    if (!line.includes('"resOutputsEvent"')) return line;
    const e = JSON.parse(line) as { resOutputsEvent: { metadata: { op: string; urn: string; plungeTimings?: unknown[] } } };
    const m = e.resOutputsEvent.metadata;
    if (m.op === "same") return line;
    m.plungeTimings = timingsFor(m.op, i * 1000);
    timed.push(m.urn);
    return JSON.stringify(e);
  });
  return { text: lines.join("\n"), timed };
}

/** A runner that answers by command, as pulumi-up.test.ts's does. */
function engine(up: () => string): PulumiRunner {
  return async (args) => {
    const save = args.indexOf("--save-plan");
    if (save >= 0) writeFileSync(args[save + 1]!, "{}\n");
    return { stdout: args[0] === "preview" ? stream : args[0] === "up" ? up() : stackOutput };
  };
}

describe("reading plungeTimings (plunge#55)", () => {
  test("an entry is kind, call, startedAt and durationMs, with failed when it failed", () => {
    expect(plungeTimingOf({ kind: "provider", call: "create", startedAt: "2026-10-27T12:00:00.123456789Z", durationMs: 812.4 })).toEqual({ kind: "provider", call: "create", startedAt: "2026-10-27T12:00:00.123456789Z", durationMs: 812.4 });
    expect(plungeTimingOf({ kind: "record", call: "write", startedAt: "2026-10-27T12:00:01Z", durationMs: 2, failed: true })).toMatchObject({ failed: true });
    for (const bad of [null, [], { kind: "lock", call: "x", startedAt: "2026-10-27T12:00:00Z", durationMs: 1 }, { kind: "provider", call: "", startedAt: "2026-10-27T12:00:00Z", durationMs: 1 }, { kind: "provider", call: "create", startedAt: "soon", durationMs: 1 }, { kind: "provider", call: "create", startedAt: "2026-10-27T12:00:00Z", durationMs: -1 }]) {
      expect(plungeTimingOf(bad)).toBeUndefined();
    }
  });

  test("timings come from outputs and failure events, joined by URN across a replacement's two events", () => {
    const vpc = urn("aws:ec2/vpc:Vpc", "main");
    const line = (o: unknown) => `${JSON.stringify(o)}\n`;
    const text =
      line({ resourcePreEvent: { metadata: { op: "create-replacement", urn: vpc, plungeTimings: [{ kind: "provider", call: "check", startedAt: at(0), durationMs: 1 }] } } }) +
      line({ resOutputsEvent: { metadata: { op: "create-replacement", urn: vpc, plungeTimings: [{ kind: "provider", call: "create", startedAt: at(0), durationMs: 500 }, { kind: "record", call: "write", startedAt: at(500), durationMs: 5 }] } } }) +
      line({ resOutputsEvent: { metadata: { op: "delete-replaced", urn: vpc, plungeTimings: [{ kind: "provider", call: "delete", startedAt: at(600), durationMs: 300 }, { phase: "old shape" }] } } }) +
      line({ resOpFailedEvent: { metadata: { op: "update", urn: urn("aws:sqs/queue:Queue", "events"), plungeTimings: [{ kind: "provider", call: "update", startedAt: at(10), durationMs: 40, failed: true }] }, status: 1, steps: 0 } });
    const timings = pulumiStreamTimings(text);
    expect(timings[vpc]!.map((t) => t.call)).toEqual(["create", "write", "delete"]);
    expect(timings[urn("aws:sqs/queue:Queue", "events")]).toEqual([{ kind: "provider", call: "update", startedAt: at(10), durationMs: 40, failed: true }]);
  });

  test("a stock Pulumi stream has no timings, and its summary carries none", () => {
    expect(pulumiStreamTimings(upStream)).toEqual({});
    expect(pulumiStreamSummary(upStream)?.timings).toBeUndefined();
  });
});

describe("timings as spans (#4579)", () => {
  test("a resource is one span from its first call to its last, with a child per call", () => {
    const u = urn("corpus:index:Site$aws:s3/bucket:Bucket", "docs-assets");
    expect(pulumiUrnParts(u)).toEqual({ type: "aws:s3/bucket:Bucket", name: "docs-assets" });
    const span = plungeResourceSpan(u, timingsFor("update", 0))!;
    expect(span).toMatchObject({
      name: u,
      startedAt: "2026-10-27T12:00:00.000Z",
      durationMs: 851.25,
      attributes: { urn: u, "resource.type": "aws:s3/bucket:Bucket", "resource.name": "docs-assets", "plunge.calls": 3, "plunge.provider_ms": 815.9, "plunge.record_ms": 21.25 },
    });
    expect(span.children!.map((c) => [c.name, c.durationMs])).toEqual([["provider diff", 3.5], ["provider update", 812.4], ["record write", 21.25]]);
    expect(span.failed).toBeUndefined();
  });

  test("the stack's totals name the slowest call, and an empty set gives nothing", () => {
    const a = urn("aws:sqs/queue:Queue", "events");
    const b = urn("aws:ec2/vpc:Vpc", "main");
    const totals = plungeTimingTotals({ [a]: timingsFor("update", 0), [b]: [{ kind: "provider", call: "create", startedAt: at(0), durationMs: 2000, failed: true }] });
    expect(totals).toEqual({
      "plunge.resources": 2,
      "plunge.calls": 4,
      "plunge.provider_ms": 2815.9,
      "plunge.record_ms": 21.25,
      "plunge.failed_calls": 1,
      "plunge.slowest.urn": b,
      "plunge.slowest.call": "provider create",
      "plunge.slowest.ms": 2000,
    });
    expect(plungeTimingTotals({})).toEqual({});
    expect(plungeTimingSpans(undefined)).toEqual([]);
  });

  test("pulumi-up's facts carry a span per timed resource on plunge, and none on stock", () => {
    const { text, timed } = plungeUpStream();
    const summary = pulumiStreamSummary(text);
    const base = { member: "corpus-aws-ts/floci", stack: "floci", planDigest: "sha256:x", fromWavePlan: true, outputs: {} };
    const plunge = pulumiTraceFacts({ dir, stack: "floci" }, { output: { ...base, engine: "plunge", ...(summary ? { summary } : {}) } });
    expect(plunge.spans!.map((s) => s.name)).toEqual(timed);
    expect(plunge.attributes!["plunge.resources"]).toBe(timed.length);
    const stockSummary = pulumiStreamSummary(upStream);
    const stock = pulumiTraceFacts({ dir, stack: "floci" }, { output: { ...base, engine: "pulumi", ...(stockSummary ? { summary: stockSummary } : {}) } });
    expect(stock.spans).toBeUndefined();
    expect(Object.keys(stock.attributes!).some((k) => k.startsWith("plunge."))).toBe(false);
  });
});

describe("a plunge up's timings in its run record and trace (#4579 acceptance, against fakes)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function collector(): Promise<{ url: string; bodies: unknown[] }> {
    const bodies: unknown[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.end("{}");
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    close = () => new Promise((done) => server.close(() => done()));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
  }

  async function wave(engineName: "plunge" | "pulumi", up: () => string) {
    const c = await collector();
    const runner = engine(up);
    const cap = createPulumiUpCapability({ ...(engineName === "plunge" ? { plunge: runner } : { run: runner }), env: {}, tmp: mkdtempSync(join(tmpdir(), "plunge-timings-")), snapshots: null });
    const registry = new CapabilityRegistry().register(cap as Capability<never, unknown>);
    const spec: OpWavesSpec = { name: "stacks", op: "pulumi-up", step: { kind: "pulumi-up", dir, stack: "floci", engine: engineName }, waves: [{ name: "floci", runs: [{ target: "site" }], gate: "never" }] };
    const cwd = mkdtempSync(join(tmpdir(), "plunge-timings-wave-"));
    const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(spec) });
    const records: OpRunRecordInput[] = [];
    const result = await runOpWave({
      spec,
      specFile: "waves.json",
      wave: 1,
      cwd,
      show,
      gates: memoryGateLedgerPort(),
      runs: { append: async (r) => void records.push(r) },
      capabilities: registry,
      lockGrain: "target",
      otlp: createOtlpExporter(otlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: c.url }, { prefix: "plywood" })!),
      log: () => {},
    });
    type SpanJson = { name: string; spanId: string; parentSpanId?: string };
    const spans = (c.bodies[0] as { resourceSpans: Array<{ scopeSpans: Array<{ spans: SpanJson[] }> }> }).resourceSpans[0]!.scopeSpans[0]!.spans;
    return { result, record: records[0]!, spans };
  }

  test("a plunge up records each resource's timings in its run record, and its trace has a span per resource", async () => {
    const { text, timed } = plungeUpStream();
    const { result, record, spans } = await wave("plunge", () => text);
    expect(result).toMatchObject({ exitCode: 0, applied: ["site"] });
    const site = record.wave!.targets!.site!;
    expect(site.spans!.map((s) => s.name)).toEqual(timed);
    expect(site.spans![0]!.children).toHaveLength(3);
    expect(site.attributes).toMatchObject({ engine: "plunge", "plunge.resources": timed.length });
    const stack = spans.find((s) => s.name === "site")!;
    const resources = spans.filter((s) => s.parentSpanId === stack.spanId);
    expect(resources.map((s) => s.name)).toEqual(timed);
    for (const r of resources) expect(spans.filter((s) => s.parentSpanId === r.spanId)).toHaveLength(3);
  });

  test("a stock Pulumi up records no timings and is not an error", async () => {
    const { result, record, spans } = await wave("pulumi", () => upStream);
    expect(result).toMatchObject({ exitCode: 0, applied: ["site"] });
    expect(record.wave!.targets!.site!.spans).toBeUndefined();
    expect(record.status).toBe("ok");
    const stack = spans.find((s) => s.name === "site")!;
    expect(spans.filter((s) => s.parentSpanId === stack.spanId)).toEqual([]);
  });
});
