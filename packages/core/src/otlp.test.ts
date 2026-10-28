/**
 * chant's OTLP exporter (#4555), against a fake collector on loopback: no
 * real endpoint is reached.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  configureOtlp,
  createOtlpExporter,
  otlpFromEnv,
  otlpTracesBody,
  OtlpTrace,
  parseTraceparent,
  prefixedAttrs,
  resetOtlp,
  RunEventTrace,
  activeOtlp,
} from "./otlp";
import { setActiveProductWords } from "./ci-product-words";
import type { RunEventRun } from "./run-event";

interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: { resourceSpans: Array<{ resource: { attributes: Attr[] }; scopeSpans: Array<{ scope: { name: string }; spans: Span[] }> }> };
}
interface Attr {
  key: string;
  value: { stringValue?: string; intValue?: string; boolValue?: boolean; doubleValue?: number };
}
interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attr[];
  events?: Array<{ name: string; attributes: Attr[] }>;
  status: { code: number; message?: string };
}

/** A collector on 127.0.0.1 that keeps what it is sent and answers `status`. */
async function fakeCollector(status = 200): Promise<{ url: string; received: Received[]; close(): Promise<void> }> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      res.statusCode = status;
      res.end(status === 200 ? "{}" : "refused");
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, received, close: () => new Promise((done) => server.close(() => done())) };
}

const attr = (span: Span, key: string): unknown => {
  const v = span.attributes.find((a) => a.key === key)?.value;
  return v === undefined ? undefined : v.stringValue ?? (v.intValue !== undefined ? Number(v.intValue) : v.boolValue ?? v.doubleValue);
};

const run: RunEventRun = { runId: "local-1", kind: "op", name: "pulumi-up", gitSha: "a".repeat(40), runtime: "local", runOrigin: { forge: "local" } };

describe("the exporter's settings (#4555)", () => {
  afterEach(() => {
    setActiveProductWords(undefined);
    resetOtlp();
  });

  test("is off with no endpoint, or when the SDK is disabled or traces say none", () => {
    expect(otlpFromEnv({})).toBeUndefined();
    expect(otlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318", OTEL_SDK_DISABLED: "true" })).toBeUndefined();
    expect(otlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318", OTEL_TRACES_EXPORTER: "none" })).toBeUndefined();
  });

  test("adds /v1/traces to the base URL, takes the traces URL as given, and merges the headers", () => {
    expect(otlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318/" })?.traces?.url).toBe("http://127.0.0.1:4318/v1/traces");
    const c = otlpFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:9999/t",
      OTEL_EXPORTER_OTLP_HEADERS: "a=1,b=x%20y",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "b=2",
    });
    expect(c?.traces).toEqual({ url: "http://127.0.0.1:9999/t", headers: { a: "1", b: "2" } });
  });

  test("names why grpc and a non-http URL send nothing", () => {
    // Nothing is sent, so the settings carry no traces endpoint at all.
    const grpc = otlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4317", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" });
    expect(grpc).toMatchObject({ skipped: [expect.stringContaining("grpc")] });
    expect(grpc?.traces).toBeUndefined();
    expect(otlpFromEnv({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "unix:///sock" })?.skipped[0]).toContain("not an http or https URL");
  });

  test("takes the product's prefix from its words, and service.name falls back to it", () => {
    expect(otlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" })).toMatchObject({ prefix: "chant", resource: { "service.name": "chant" } });
    setActiveProductWords({ product: "plywood" });
    expect(otlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" })).toMatchObject({ prefix: "plywood", resource: { "service.name": "plywood" } });
    expect(otlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318", OTEL_SERVICE_NAME: "estate" }, { prefix: "terragucci" })).toMatchObject({ prefix: "terragucci", resource: { "service.name": "estate" } });
    expect(() => otlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" }, { prefix: "Bad Prefix" })).toThrow(/not a product name/);
  });

  test("configureOtlp sets the exporter once; activeOtlp reads the environment when none was configured", () => {
    expect(configureOtlp({ prefix: "terragucci", env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" } })?.config.prefix).toBe("terragucci");
    expect(activeOtlp()?.config.prefix).toBe("terragucci");
    expect(configureOtlp({ env: {} })).toBeUndefined();
    expect(activeOtlp()).toBeUndefined();
  });

  test("prefixes chant's keys and leaves semantic conventions as they are", () => {
    expect(prefixedAttrs("plywood", { stack: "dev", "plywood.member": "web/dev", "vcs.ref.head.revision": "abc", "service.name": "x", skip: undefined })).toEqual({
      "plywood.stack": "dev",
      "plywood.member": "web/dev",
      "vcs.ref.head.revision": "abc",
      "service.name": "x",
    });
  });

  test("joins the trace TRACEPARENT names, and ignores one that is not a traceparent", () => {
    const p = `00-${"1".repeat(32)}-${"2".repeat(16)}-01`;
    expect(parseTraceparent(p)).toEqual({ traceId: "1".repeat(32), spanId: "2".repeat(16) });
    expect(parseTraceparent(`00-${"0".repeat(32)}-${"2".repeat(16)}-01`)).toBeUndefined();
    const t = new OtlpTrace(p);
    const span = t.start("run");
    expect(span).toMatchObject({ traceId: "1".repeat(32), parentSpanId: "2".repeat(16) });
    expect(t.traceparent(span)).toBe(`00-${"1".repeat(32)}-${span.spanId}-01`);
  });

  test("writes OTLP/JSON with typed values and an error status", () => {
    const t = new OtlpTrace();
    const s = t.start("step", undefined, { "plywood.count": 2, "plywood.ok": true, "plywood.rate": 0.5, "plywood.name": "x" });
    t.end(s, {}, "it failed");
    const body = otlpTracesBody(t.spans, { "service.name": "plywood" }, "0.0.0") as Received["body"];
    const span = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(body.resourceSpans[0]!.scopeSpans[0]!.scope.name).toBe("chant");
    expect(span.attributes).toEqual([
      { key: "plywood.count", value: { intValue: "2" } },
      { key: "plywood.ok", value: { boolValue: true } },
      { key: "plywood.rate", value: { doubleValue: 0.5 } },
      { key: "plywood.name", value: { stringValue: "x" } },
    ]);
    expect(span.status).toEqual({ code: 2, message: "it failed" });
  });
});

describe("a run's events as one trace (#4555)", () => {
  let collector: Awaited<ReturnType<typeof fakeCollector>>;
  beforeEach(async () => {
    collector = await fakeCollector();
  });
  afterEach(async () => {
    await collector.close();
    setActiveProductWords(undefined);
  });

  test("sends a span for the run, each phase and each step, with the product's prefix, to the collector", async () => {
    const exporter = createOtlpExporter(otlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: collector.url, OTEL_EXPORTER_OTLP_HEADERS: "x-token=t" }, { prefix: "plywood" })!);
    const trace = new RunEventTrace(run, { exporter });
    trace.sink({ type: "run-start", waves: null });
    trace.sink({ type: "phase-start", component: null, phase: "wave-1" });
    trace.sink({ type: "step-start", component: null, phase: "wave-1", step: "web/dev" });
    trace.annotate({ phase: "wave-1", step: "web/dev" }, {
      attributes: { stack: "dev", "up.create": 2 },
      spans: [{ name: "urn:pulumi:dev::web::aws:s3/bucket:Bucket::site", startedAt: "2026-10-27T10:00:00.000Z", durationMs: 1500, attributes: { kind: "provider" } }],
    });
    trace.sink({ type: "step-settle", component: null, phase: "wave-1", step: "web/dev", status: "ok", durationMs: 2000 });
    trace.sink({ type: "step-settle", component: null, phase: "wave-1", step: "api/dev", status: "skipped", skip: "not-run", durationMs: null });
    trace.sink({ type: "phase-settle", component: null, phase: "wave-1", status: "ok" });
    trace.sink({ type: "run-settle", status: "ok", durationMs: 2100 });
    expect(await trace.flush()).toBeUndefined();

    expect(collector.received).toHaveLength(1);
    const got = collector.received[0]!;
    expect(got.path).toBe("/v1/traces");
    expect(got.headers["x-token"]).toBe("t");
    expect(got.headers["content-type"]).toBe("application/json");
    const spans = got.body.resourceSpans[0]!.scopeSpans[0]!.spans;
    const byName = new Map(spans.map((s) => [s.name, s]));
    const root = byName.get("op pulumi-up")!;
    const phase = byName.get("wave-1")!;
    const step = byName.get("web/dev")!;
    const resource = byName.get("urn:pulumi:dev::web::aws:s3/bucket:Bucket::site")!;
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);
    expect(root.parentSpanId).toBeUndefined();
    expect(phase.parentSpanId).toBe(root.spanId);
    expect(step.parentSpanId).toBe(phase.spanId);
    expect(resource.parentSpanId).toBe(step.spanId);
    expect(byName.get("api/dev")!.parentSpanId).toBe(phase.spanId);
    expect(attr(root, "plywood.run.id")).toBe("local-1");
    expect(attr(root, "vcs.ref.head.revision")).toBe("a".repeat(40));
    expect(attr(step, "plywood.stack")).toBe("dev");
    expect(attr(step, "plywood.up.create")).toBe(2);
    expect(attr(step, "plywood.status")).toBe("ok");
    expect(attr(resource, "plywood.kind")).toBe("provider");
    expect(resource.kind).toBe(3);
    expect(BigInt(resource.endTimeUnixNano) - BigInt(resource.startTimeUnixNano)).toBe(1_500_000_000n);
    expect(attr(byName.get("api/dev")!, "plywood.skip")).toBe("not-run");
    expect(spans.every((s) => s.attributes.every((a) => a.key.startsWith("plywood.") || a.key.startsWith("vcs.")))).toBe(true);
  });

  test("a gate a step waits at is an event on its span, and a failed run is an error status with its failure", async () => {
    const exporter = createOtlpExporter(otlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: collector.url }, { prefix: "terragucci" })!);
    const trace = new RunEventTrace(run, { exporter });
    trace.sink({ type: "step-start", component: null, phase: "wave-2", step: "gate:wave-2" });
    trace.sink({ type: "gate-waiting", component: null, phase: "wave-2", step: "gate:wave-2", op: "tf-apply", gate: "wave-2", point: null });
    trace.sink({ type: "step-settle", component: null, phase: "wave-2", step: "gate:wave-2", status: "gated", durationMs: null });
    trace.sink({ type: "run-settle", status: "failed", durationMs: null, failure: { code: "moved", reason: "plans moved", exitCode: 4 } });
    await trace.flush();
    const spans = collector.received[0]!.body.resourceSpans[0]!.scopeSpans[0]!.spans;
    const gate = spans.find((s) => s.name === "gate:wave-2")!;
    expect(gate.events?.[0]?.name).toBe("gate-waiting");
    expect(attr(gate as Span, "terragucci.status")).toBe("gated");
    const root = spans.find((s) => s.name === "op pulumi-up")!;
    expect(root.status).toEqual({ code: 2, message: "plans moved" });
    expect(attr(root, "terragucci.failure.code")).toBe("moved");
    expect(attr(root, "terragucci.failure.exit_code")).toBe(4);
  });

  test("a component run's waves and components are spans, and a collector that refuses is a problem, never a throw", async () => {
    const refusing = await fakeCollector(503);
    const exporter = createOtlpExporter(otlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: refusing.url })!);
    const trace = new RunEventTrace({ ...run, kind: "component", name: "web" }, { exporter });
    trace.sink({ type: "run-start", waves: [["web"]] });
    trace.sink({ type: "wave-start", wave: 1, components: ["web"] });
    trace.sink({ type: "component-start", wave: 1, component: "web" });
    trace.sink({ type: "phase-start", component: "web", phase: "deploy" });
    trace.sink({ type: "component-settle", wave: 1, component: "web", status: "ok" });
    trace.sink({ type: "wave-settle", wave: 1, status: "ok" });
    trace.sink({ type: "run-settle", status: "ok", durationMs: 10 });
    expect(await trace.flush()).toMatch(/answered 503/);
    const spans = refusing.received[0]!.body.resourceSpans[0]!.scopeSpans[0]!.spans;
    const wave = spans.find((s) => s.name === "wave 1")!;
    const component = spans.find((s) => s.name === "web" && s.parentSpanId === wave.spanId)!;
    expect(spans.find((s) => s.name === "deploy")!.parentSpanId).toBe(component.spanId);
    await refusing.close();
  });
});
