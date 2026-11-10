/**
 * Per-root engine timings (chant#4887): `engineTimings()`'s hook, passed as
 * `terraformApplyCapabilityWith({ onCommand })`, times each root's commands
 * and collects the spans the engine sends to its loopback receiver, read into
 * per-root plan and apply seconds, span counts and lock waits. A plain wave
 * runs through core's `runOpWave` with a fake `terraform` on `PATH`, a Node
 * script that sends OTLP/JSON spans where the variables point it; a composed
 * group's commands run through `hookedBinaryExec` with a fake exec. Nothing
 * reaches a cloud or a collector off the machine.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CapabilityRegistry, type Capability } from "@intentius/chant/components/capability";
import { memoryGateLedgerPort, runOpWave, type OpWavesSpec } from "@intentius/chant/op";
import { terraformApplyCapabilityWith } from "./components/capability-plugin";
import { decodeTracesJson, ENGINE_RUN_HEADER, engineTimings, rootTimings, SpanReceiver, type CollectedSpan } from "./engine-timings";
import { hookedBinaryExec, withTerraformCommandHook } from "./op/command-hook";
import type { BinaryExec } from "./state/exec";

afterEach(() => vi.unstubAllEnvs());

/** OTLP/JSON for spans of `ms` milliseconds each. */
const otlp = (spans: Array<{ name: string; ms: number; attributes?: Record<string, string | number> }>) => ({
  resourceSpans: [
    {
      scopeSpans: [
        {
          spans: spans.map((s, i) => ({
            spanId: `s${i}`,
            name: s.name,
            startTimeUnixNano: "1000000000",
            endTimeUnixNano: String(1_000_000_000 + s.ms * 1_000_000),
            attributes: Object.entries(s.attributes ?? {}).map(([key, v]) => ({ key, value: typeof v === "number" ? { intValue: String(v) } : { stringValue: v } })),
          })),
        },
      ],
    },
  ],
});

describe("reading the engine's spans", () => {
  test("a root's resources, provider calls and lock waits come from its spans", () => {
    const spans: CollectedSpan[] = decodeTracesJson(
      otlp([
        { name: "Plan resource instance changes", ms: 120, attributes: { "opentofu.resource_instance.address": "aws_sqs_queue.jobs", "opentofu.resource.type": "aws_sqs_queue" } },
        { name: "State lock wait", ms: 2500, attributes: { "opentofu.state.backend": "s3", "opentofu.state.lock.operation": "plan", "opentofu.state.lock.attempts": 3 } },
        { name: "tfplugin5.Provider/PlanResourceChange", ms: 40 },
      ]),
    );
    const t = rootTimings(spans, { binary: "tofu", seconds: 4, planSeconds: 3 });
    expect(t).toMatchObject({ seconds: 4, plan_seconds: 3, spans: 3, detail: "resources" });
    expect(t.resources).toEqual([{ address: "aws_sqs_queue.jobs", type: "aws_sqs_queue", ms: 120 }]);
    expect(t.lock_waits).toEqual([{ backend: "s3", operation: "plan", attempts: 3, ms: 2500 }]);
    expect(t.provider_calls).toEqual([{ method: "PlanResourceChange", ms: 40 }]);
  });

  test("the receiver keeps a batch under the key its exporter named, and refuses one with no token", async () => {
    const r = new SpanReceiver();
    expect(await r.listen()).toBeUndefined();
    const vars = r.exporter("roots/a\u0000plan");
    const token = vars.OTEL_EXPORTER_OTLP_TRACES_HEADERS!.split("=")[1]!;
    const post = (headers: Record<string, string>) =>
      fetch(vars.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT!, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(otlp([{ name: "State lock wait", ms: 10 }])) });
    expect((await post({ [ENGINE_RUN_HEADER]: token })).status).toBe(200);
    expect((await post({})).status).toBe(401);
    expect(r.spansOf("roots/a\u0000plan").map((s) => s.name)).toEqual(["State lock wait"]);
    expect(await r.close()).toEqual([]);
  });
});

/** A fake `terraform`: a Node script that answers each command and sends a plan's and an apply's spans where the variables point. */
const FAKE = (node: string) => `#!${node}
const fs = require("fs");
const [cmd, ...rest] = process.argv.slice(2);
const root = process.cwd().split("/").pop();
const send = async (spans) => {
  const url = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (!url) return;
  const [k, v] = (process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS || "").split("=");
  const span = (s, i) => ({ spanId: cmd + i, name: s[0], startTimeUnixNano: "1000000000", endTimeUnixNano: String(1000000000 + s[1] * 1000000), attributes: Object.entries(s[2] || {}).map(([key, x]) => ({ key, value: typeof x === "number" ? { intValue: String(x) } : { stringValue: x } })) });
  await fetch(url, { method: "POST", headers: { "content-type": "application/json", [k]: v }, body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: spans.map(span) }] }] }) });
};
(async () => {
  if (cmd === "plan") {
    const out = rest.find((a) => a.startsWith("-out=")).slice(5);
    fs.writeFileSync(out, "plan");
    await send([["State lock wait", root === "a" ? 300 : 0, { "opentofu.state.lock.attempts": 2 }], ["Plan resource instance changes", 50, { "opentofu.resource_instance.address": "terraform_data." + root }]].filter((s) => s[1] > 0));
    await new Promise((r) => setTimeout(r, 30));
    process.exit(2);
  }
  if (cmd === "apply") {
    await send([["Apply resource instance changes", 80, { "opentofu.resource_instance.address": "terraform_data." + root }]]);
    await new Promise((r) => setTimeout(r, 30));
  }
  if (cmd === "show") console.log(JSON.stringify({ format_version: "1.2", resource_changes: [{ address: "terraform_data." + root, mode: "managed", type: "terraform_data", name: root, change: { actions: ["create"], before: null, after: {} } }] }));
  if (cmd === "output") console.log('{"id":{"value":"x"}}');
  process.exit(0);
})();
`;

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-tf-timings-")));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "terraform"), FAKE(process.execPath));
  chmodSync(join(dir, "bin", "terraform"), 0o755);
  vi.stubEnv("PATH", `${join(dir, "bin")}:${process.env.PATH ?? ""}`);
  vi.stubEnv("TF_PLUGIN_CACHE_DIR", "");
  for (const r of ["a", "b"]) {
    mkdirSync(join(dir, "roots", r), { recursive: true });
    writeFileSync(join(dir, "roots", r, "main.tf"), "");
  }
  writeFileSync(join(dir, "chant.config.json"), JSON.stringify({ lexicons: ["terraform"], terraform: { binary: "terraform" } }));
  return dir;
}

const SPEC = {
  name: "tf-apply",
  op: "tf-apply",
  gateName: "wave-{k}",
  parallelism: 2,
  step: { kind: "terraform-apply", root: "{target}", dir: "{target}", lockTimeout: false },
  waves: [{ name: "wave-1", gate: "never", runs: [{ target: "roots/a" }, { target: "roots/b" }] }],
} as unknown as OpWavesSpec;

describe("engineTimings (chant#4887)", () => {
  test("a plain wave's roots get their plan and apply seconds, span counts and lock waits", async () => {
    const dir = project();
    const timings = await engineTimings();
    expect(timings.problem).toBeUndefined();
    const result = await runOpWave({
      spec: SPEC,
      specFile: "waves.json",
      wave: 1,
      cwd: dir,
      show: () => ({ sha: "c".repeat(40), text: JSON.stringify(SPEC) }),
      gates: memoryGateLedgerPort(),
      capabilities: new CapabilityRegistry().register(terraformApplyCapabilityWith({ onCommand: timings.onCommand }) as unknown as Capability<never, unknown>),
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    await timings.close();
    const roots = timings.roots();
    expect(Object.keys(roots)).toEqual(["roots/a", "roots/b"]);
    const a = roots["roots/a"]!;
    expect(a.commands.map((c) => `${c.method} ${c.command}`)).toEqual(["plan init", "plan plan", "plan show", "run apply", "run output"]);
    expect(a.plan_seconds).toBeGreaterThanOrEqual(0.02);
    expect(a.apply_seconds).toBeGreaterThanOrEqual(0.02);
    expect(a.seconds).toBeGreaterThanOrEqual(a.plan_seconds! + a.apply_seconds!);
    expect(a.spans).toBe(3);
    expect(a.lock_waits).toEqual([{ attempts: 2, ms: 300 }]);
    expect(a.resources.map((r) => r.address)).toEqual(["terraform_data.a", "terraform_data.a"]);
    expect(roots["roots/b"]).toMatchObject({ spans: 2, lock_waits: [] });
    expect(timings.run().roots.map((r) => r.root).sort()).toEqual(["roots/a", "roots/b"]);
  });

  test("a composed group's commands time every member, and the run counts its resources once", async () => {
    const timings = await engineTimings({ noSpans: true });
    const fake: BinaryExec = async (_bin, args) => {
      await new Promise((r) => setTimeout(r, 10));
      return { code: 0, stdout: args[0] === "plan" ? "Plan: 2 to add" : "", out: "" };
    };
    const exec = hookedBinaryExec(fake);
    const seen: string[] = [];
    const hook = timings.onCommand;
    const watched: typeof hook = async (c) => {
      seen.push(`${c.method} ${c.name} ${(c.members ?? []).join(",")}`);
      return hook(c);
    };
    await withTerraformCommandHook(watched, { root: "roots/a", members: ["roots/a", "roots/b"], method: "plan" }, async () => {
      await exec("tofu", ["init", "-input=false"], "/w/.chant-compose", {});
      await exec("tofu", ["plan", "-out=/w/composed.tfplan"], "/w/.chant-compose", {});
    });
    await withTerraformCommandHook(watched, { root: "roots/a", members: ["roots/a", "roots/b"], method: "run" }, async () => {
      await exec("tofu", ["apply", "-json", "/w/composed.tfplan"], "/w/.chant-compose", {});
    });
    expect(seen).toEqual(["plan init roots/a,roots/b", "plan plan roots/a,roots/b", "run apply roots/a,roots/b"]);
    const roots = timings.roots();
    for (const r of ["roots/a", "roots/b"]) {
      expect(roots[r]!.composed).toEqual(["roots/a", "roots/b"]);
      expect(roots[r]!.plan_seconds).toBeGreaterThan(0);
      expect(roots[r]!.apply_seconds).toBeGreaterThan(0);
      expect(roots[r]!.commands.map((c) => c.command)).toEqual(["init", "plan", "apply"]);
    }
  });

  test("the product's own hook runs first: its variables reach the command under the receiver's, and its after runs", async () => {
    const afters: string[] = [];
    const got: Array<Record<string, string | undefined>> = [];
    const fake: BinaryExec = async (_bin, _args, _dir, env) => {
      got.push({ TRACEPARENT: env.TRACEPARENT, endpoint: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT });
      return { code: 0, stdout: "", out: "" };
    };
    const timings = await engineTimings({ inner: () => ({ env: { TRACEPARENT: "00-abc-def-01" }, after: (r) => void afters.push(String(r.code)) }) });
    await withTerraformCommandHook(timings.onCommand, { root: "roots/a", method: "plan" }, () => hookedBinaryExec(fake)("tofu", ["plan"], "/w", {}));
    expect(got[0]!.TRACEPARENT).toBe("00-abc-def-01");
    expect(got[0]!.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/traces$/);
    expect(afters).toEqual(["0"]);
    expect(timings.root("roots/a")!.commands).toEqual([{ command: "plan", method: "plan", seconds: expect.any(Number), code: 0 }]);
    await timings.close();
  });
});
