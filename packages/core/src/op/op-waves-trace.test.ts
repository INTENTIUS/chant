/**
 * An op wave job's run events and trace (#4555): a phase per wave and a step
 * per run target, settled as the run record says, and one trace through
 * chant's exporter to a fake collector on loopback.
 */

import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";
import { CapabilityRegistry, type Capability } from "../components/capability";
import type { ChangeSetPart } from "../change-set";
import type { RunEventBody } from "../run-event";
import type { OpRunRecordInput } from "./runtime";
import { createOtlpExporter, otlpFromEnv } from "../otlp";
import { OpWaveRunEvents } from "./op-waves-events";

const digest = (n: string) => `sha256:${n.repeat(64)}`;

const part = (member: string): ChangeSetPart => ({
  member: { member, lexicon: "terraform", planner: "chant", status: "planned", planDigest: digest("9"), holes: [] },
  entries: [
    { member, address: `aws_s3_bucket.${member}`, type: "aws_s3_bucket", action: "create" } as ChangeSetPart["entries"][number],
    { member, address: `aws_iam_role.${member}`, type: "aws_iam_role", action: "update" } as ChangeSetPart["entries"][number],
  ],
});

/** A capability that plans and applies each root, fails `failing`, and says what it timed. */
function capability(digests: Record<string, string>, failing: string[] = []): CapabilityRegistry {
  const cap: Capability<Record<string, unknown>, unknown> = {
    kind: "fake-apply",
    async plan(_ctx, input) {
      const root = String(input.root);
      return { member: root, planDigest: digests[root]!, artifact: { root }, changeSet: part(root) };
    },
    async run(_ctx, input) {
      if (failing.includes(String(input.root))) throw new Error(`${input.root} broke`);
      return { applied: input.root };
    },
    traceFacts(input, outcome) {
      return {
        attributes: { root: String(input.root), binary: "tofu", ok: "output" in outcome },
        spans: [{ name: `aws_s3_bucket.${input.root}`, startedAt: "2026-10-27T10:00:00.000Z", durationMs: 250, attributes: { kind: "provider", call: "Create" } }],
      };
    },
  };
  return new CapabilityRegistry().register(cap);
}

const spec: OpWavesSpec = {
  name: "roots",
  op: "tf-apply",
  step: { kind: "fake-apply", root: "{target}" },
  waves: [{ name: "dev", runs: [{ target: "network" }, { target: "app" }], gate: "never" }],
};

function harness(s: OpWavesSpec) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-trace-"));
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(s) });
  return { cwd, show, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

async function collector(): Promise<{ url: string; bodies: unknown[]; close(): Promise<void> }> {
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
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies, close: () => new Promise((done) => server.close(() => done())) };
}

type SpanJson = { name: string; spanId: string; parentSpanId?: string; attributes: Array<{ key: string; value: Record<string, unknown> }>; status: { code: number } };
const spansOf = (body: unknown): SpanJson[] => (body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: SpanJson[] }> }> }).resourceSpans[0]!.scopeSpans[0]!.spans;
const attr = (s: SpanJson, key: string) => s.attributes.find((a) => a.key === key)?.value;

describe("an op wave job's run events and trace (#4555)", () => {
  let c: Awaited<ReturnType<typeof collector>> | undefined;
  afterEach(async () => {
    await c?.close();
    c = undefined;
  });

  test("streams a phase per wave and a step per run target, and sends one trace with a span per root", async () => {
    c = await collector();
    const h = harness(spec);
    const events: RunEventBody[] = [];
    const records: OpRunRecordInput[] = [];
    const exporter = createOtlpExporter(otlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: c.url }, { prefix: "terragucci" })!);
    const result = await runOpWave({
      spec,
      specFile: "waves.json",
      wave: 1,
      cwd: h.cwd,
      show: h.show,
      gates: memoryGateLedgerPort(),
      runs: { append: async (r) => void records.push(r) },
      capabilities: capability({ network: digest("1"), app: digest("2") }, ["app"]),
      events: (b) => events.push(b),
      otlp: exporter,
      log: () => {},
    });
    expect(result).toMatchObject({ exitCode: 1, applied: ["network"], failed: ["app"] });

    // The stream: run-start, the phase, each target as it applied, then the settles.
    expect(events.map((e) => [e.type, "step" in e ? e.step : "phase" in e ? e.phase : ""])).toEqual([
      ["run-start", ""],
      ["phase-start", "wave-1"],
      ["step-start", "network"],
      ["step-settle", "network"],
      ["step-start", "app"],
      ["step-settle", "app"],
      ["phase-settle", "wave-1"],
      ["run-settle", ""],
    ]);
    expect(events.find((e) => e.type === "step-settle" && e.step === "app")).toMatchObject({ status: "failed", error: "app broke" });
    expect(events.at(-1)).toMatchObject({ type: "run-settle", status: "failed", failure: { code: "command-failed", exitCode: 1 } });

    // The run record carries each target's time and facts.
    const wave = records[0]!.wave!;
    expect(Object.keys(wave.targets ?? {})).toEqual(["network", "app"]);
    expect(wave.targets!.network).toMatchObject({ attributes: { member: "network", kind: "fake-apply", "resources.create": 1, "resources.update": 1, root: "network", binary: "tofu", ok: true } });
    expect(wave.targets!.network!.spans).toEqual([{ name: "aws_s3_bucket.network", startedAt: "2026-10-27T10:00:00.000Z", durationMs: 250, attributes: { kind: "provider", call: "Create" } }]);
    expect(records[0]!.phases[0]!.steps.map((s) => s.fn)).toEqual(["network", "app"]);

    // One trace: the job, its wave, a span per root, and the timed resource under each.
    expect(c.bodies).toHaveLength(1);
    const spans = spansOf(c.bodies[0]);
    const root = spans.find((s) => s.name === "op roots")!;
    const phase = spans.find((s) => s.name === "wave-1")!;
    const network = spans.find((s) => s.name === "network")!;
    const app = spans.find((s) => s.name === "app")!;
    expect(phase.parentSpanId).toBe(root.spanId);
    expect(network.parentSpanId).toBe(phase.spanId);
    expect(app.status.code).toBe(2);
    expect(attr(network, "terragucci.root")).toEqual({ stringValue: "network" });
    expect(attr(network, "terragucci.resources.create")).toEqual({ intValue: "1" });
    expect(spans.find((s) => s.name === "aws_s3_bucket.network")!.parentSpanId).toBe(network.spanId);
    h.done();
  });

  test("a job that waits at its gate ends its stream on a gate step, and otlp: false sends nothing", async () => {
    c = await collector();
    const gated: OpWavesSpec = { ...spec, waves: [{ ...spec.waves[0]!, gate: "always" }] };
    const h = harness(gated);
    const events: RunEventBody[] = [];
    const result = await runOpWave({
      spec: gated,
      specFile: "waves.json",
      wave: 1,
      cwd: h.cwd,
      show: h.show,
      gates: memoryGateLedgerPort(),
      capabilities: capability({ network: digest("1"), app: digest("2") }),
      events: (b) => events.push(b),
      otlp: false,
      log: () => {},
    });
    expect(result.exitCode).toBe(3);
    const tail = events.slice(-6).map((e) => [e.type, "status" in e ? e.status : undefined]);
    expect(tail).toEqual([
      ["step-settle", "skipped"],
      ["step-start", undefined],
      ["gate-waiting", undefined],
      ["step-settle", "gated"],
      ["phase-settle", "gated"],
      ["run-settle", "gated"],
    ]);
    expect(events.find((e) => e.type === "gate-waiting")).toMatchObject({ op: "tf-apply", step: expect.stringMatching(/^gate:/) });
    expect(c.bodies).toHaveLength(0);
    h.done();
  });

  test("the emitter settles targets the job never applied from the record, saying why", () => {
    const events: RunEventBody[] = [];
    const e = new OpWaveRunEvents((b) => events.push(b));
    e.start();
    e.stepStart(1, "vpc");
    e.stepSettle(1, "vpc", "ok", 10);
    e.finish(
      {
        op: "tf-apply", env: "local", started: "2026-10-27T10:00:00Z", ended: "2026-10-27T10:00:05Z", status: "fail", labels: {}, outcomes: {},
        phases: [{ name: "wave-1", status: "fail", steps: [{ fn: "vpc", status: "ok", durationMs: 10 }, { fn: "dns", status: "skipped", durationMs: 0 }, { fn: "cdn", status: "skipped", durationMs: 0 }] }],
        failure: { code: "moved", reason: "plans moved", exitCode: 4 },
      },
      { moved: ["dns"], blocked: { cdn: "dns" } },
    );
    expect(events.filter((x) => x.type === "step-settle").map((x) => x.type === "step-settle" && [x.step, x.status, x.skip ?? null, x.message ?? null])).toEqual([
      ["vpc", "ok", null, null],
      ["dns", "skipped", "refused", "its plan moved since the wave was decided"],
      ["cdn", "skipped", "not-run", "blocked by dns"],
    ]);
    expect(events.at(-1)).toMatchObject({ type: "run-settle", status: "failed", durationMs: 5000, failure: { code: "moved" } });
  });
});
