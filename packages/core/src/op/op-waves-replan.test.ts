/**
 * The replan step in a wave job (#5345): once a wave applied, the job runs
 * `chant components replan` for the runs it applied when the spec at base
 * names one in `replanDependents`, and runs nothing without it. A failure of
 * the step is a log line and leaves the wave applied.
 */

import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";
import { CapabilityRegistry, type Capability } from "../components/capability";
import { asPipelineSpec } from "../pipeline/spec";
import { stageWavesSpec } from "../pipeline/stages";

const COMMIT = "c".repeat(40);

function registry(): CapabilityRegistry {
  const cap: Capability<Record<string, unknown>, unknown> = {
    kind: "fake-up",
    async plan(_ctx, input) {
      return { member: String(input.stack), planDigest: `sha256:${"1".repeat(64)}`, artifact: {} };
    },
    async run(_ctx, input) {
      return { applied: input.stack };
    },
  };
  return new CapabilityRegistry().register(cap);
}

const spec: OpWavesSpec = {
  name: "deliver-prod",
  op: "deliver",
  labels: { Env: "prod" },
  step: { kind: "fake-up", stack: "{target}" },
  waves: [{ name: "w", runs: [{ target: "network" }, { target: "app" }], gate: "never" }],
};

async function wave(s: OpWavesSpec, atBase: OpWavesSpec, replan: (input: { cwd: string; env: string; components: string[]; replanDependents: string[] }) => Promise<string>) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-replan-"));
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(atBase) });
  const log: string[] = [];
  try {
    const result = await runOpWave({ spec: s, specFile: "waves.json", wave: 1, cwd, show, head: COMMIT, gates: memoryGateLedgerPort(), runs: { append: async () => {} }, releases: false, capabilities: registry(), replan, log: (l) => log.push(l) });
    return { result, log };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("the replan step after a wave applied (#5345)", () => {
  test("runs for the applied runs, in the stage's environment, when the spec at base names one", async () => {
    const asked: unknown[] = [];
    const s = { ...spec, replanDependents: ["network"] };
    const { result, log } = await wave(s, s, async (input) => {
      asked.push({ env: input.env, components: input.components, replanDependents: input.replanDependents });
      return "replan: network (vpcId) read by dns; plan x waits at pr-apply-replan (pending)";
    });
    expect(result.exitCode).toBe(0);
    expect(asked).toEqual([{ env: "prod", components: ["app", "network"], replanDependents: ["network"] }]);
    expect(log).toContain("wave 1: replan: network (vpcId) read by dns; plan x waits at pr-apply-replan (pending)");
  });

  test("runs nothing when the spec at base sets none, whatever the change's spec says", async () => {
    const asked: unknown[] = [];
    const { result } = await wave({ ...spec, replanDependents: ["network"] }, spec, async (input) => (asked.push(input), ""));
    expect(result.exitCode).toBe(0);
    expect(asked).toEqual([]);
  });

  test("runs nothing when no applied run is named", async () => {
    const asked: unknown[] = [];
    const s = { ...spec, replanDependents: ["shared/*"] };
    await wave(s, s, async (input) => (asked.push(input), ""));
    expect(asked).toEqual([]);
  });

  test("a step that throws is a log line, and the wave stays applied", async () => {
    const s = { ...spec, replanDependents: ["network"] };
    const { result, log } = await wave(s, s, async () => {
      throw new Error("no lifecycle branch");
    });
    expect(result.exitCode).toBe(0);
    expect(result.applied).toEqual(["network", "app"]);
    expect(log).toContain("wave 1: the dependents of the applied runs were not planned again: no lifecycle branch");
  });

  test("a pipeline stage's replanDependents reaches the spec its wave jobs read; unset, the spec is the one it was", () => {
    const decl = (stage: Record<string, unknown>) =>
      asPipelineSpec({ name: "deliver", defaults: { op: "deliver", step: { kind: "fake-up", stack: "{target}" } }, stages: [{ name: "prod", waves: [{ name: "w", runs: [{ target: "network" }] }], ...stage }] });
    const unset = stageWavesSpec(decl({}), "prod");
    expect("replanDependents" in unset).toBe(false);
    expect(stageWavesSpec(decl({ replanDependents: ["network"] }), "prod")).toEqual({ ...unset, replanDependents: ["network"] });
  });
});
