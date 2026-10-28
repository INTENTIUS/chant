/**
 * Runs a wave applies at once (#4625): `parallelism` on the spec or a wave,
 * with a capability step, at most that many applies in flight, a run
 * waiting for an earlier run it depends on and blocked when that failed.
 * Written for the ci-products post-merge pass.
 */

import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertOpWavesSpec, type OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";
import { CapabilityRegistry, type Capability } from "../components/capability";

const digest = (n: string) => `sha256:${n.repeat(64)}`;

function capability(opts: { fail?: string[]; delayMs?: number } = {}) {
  const seen = { running: 0, most: 0, order: [] as string[] };
  const cap: Capability<Record<string, unknown>, unknown> = {
    kind: "fake-apply",
    async plan(_ctx, input) {
      const root = String(input.root);
      return { member: root, planDigest: digest("1"), artifact: {}, changeSet: { member: { member: root, lexicon: "terraform", planner: "chant", status: "planned", planDigest: digest("1"), holes: [] }, entries: [] } };
    },
    async run(_ctx, input) {
      const root = String(input.root);
      seen.running++;
      seen.most = Math.max(seen.most, seen.running);
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 5));
      seen.running--;
      seen.order.push(root);
      if (opts.fail?.includes(root)) throw new Error(`${root} broke`);
      return { applied: root };
    },
  };
  return { registry: new CapabilityRegistry().register(cap), seen };
}

const spec = (parallelism: number, runs: OpWavesSpec["waves"][number]["runs"]): OpWavesSpec => ({
  name: "roots",
  op: "tf-apply",
  parallelism,
  step: { kind: "fake-apply", root: "{target}" },
  waves: [{ name: "dev", runs, gate: "never" }],
});

async function run(s: OpWavesSpec, registry: CapabilityRegistry) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-par-"));
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(s) });
  try {
    return await runOpWave({ spec: s, specFile: "waves.json", wave: 1, cwd, show, gates: memoryGateLedgerPort(), capabilities: registry });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("runs applied at once (#4625)", () => {
  test("at most parallelism applies in flight, and the result keeps the wave's order", async () => {
    const { registry, seen } = capability();
    const result = await run(spec(2, [{ target: "a" }, { target: "b" }, { target: "c" }, { target: "d" }]), registry);
    expect(result).toMatchObject({ exitCode: 0, applied: ["a", "b", "c", "d"] });
    expect(seen.most).toBe(2);
  });

  test("a run waits for an earlier run it depends on, and is blocked when that one failed", async () => {
    const { registry, seen } = capability({ fail: ["a"] });
    const result = await run(spec(3, [{ target: "a" }, { target: "b", dependsOn: ["a"] }, { target: "c" }, { target: "d", dependsOn: ["b"] }]), registry);
    expect(result.exitCode).toBe(1);
    expect(result.failed).toEqual(["a"]);
    expect(result.applied).toEqual(["c"]);
    expect(result.blocked).toEqual({ b: "a", d: "a" });
    expect(seen.order).not.toContain("b");
  });

  test("one at a time when the spec says nothing", async () => {
    const { registry, seen } = capability();
    const { parallelism: _p, ...plain } = spec(1, [{ target: "a" }, { target: "b" }]);
    await run(plain, registry);
    expect(seen.most).toBe(1);
  });

  test("the spec refuses a parallelism over 1 without a step, and one that is not a whole number", () => {
    const { step: _s, ...noStep } = spec(2, [{ target: "a" }]);
    expect(() => assertOpWavesSpec({ ...noStep, apply: ["./apply", "{target}"], plan: ["./plan", "{target}", "{plan}"] })).toThrow(/apply at once only through `step`/);
    expect(() => assertOpWavesSpec(spec(0, [{ target: "a" }]))).toThrow(/whole number of 1 or more/);
  });
});
