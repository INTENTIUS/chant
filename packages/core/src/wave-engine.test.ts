/**
 * One wave engine under both runners (#3766): the same runs, planned to the
 * same digests, are the same set digest and the same gate name whether
 * `chant run wave` (an Op waves spec) or `chant components fan-out
 * --wave-gate` decides the wave. An approval recorded through one matches a
 * wave the other plans.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { memoryGateLedgerPort } from "./op/gate";
import { runOpWave, type OpWaveExec, type OpWaveShowAtBase } from "./op/op-waves-run";
import { opWaveGateName, opWaveShare, type OpWavesSpec } from "./op/op-waves";
import { planFanOut } from "./components/fan-out";
import { runFanOut } from "./components/fan-out-run";
import { CapabilityRegistry } from "./components/capability";
import type { DriverComponent } from "./components/driver";
import { runWaveLoop, waveGateName, waveGateNameFrom, waveSetDigest, waveShare, WAVE_GATE_NAME_PATTERN, type WaveLoopSteps } from "./wave-engine";

const digest = (n: string) => `sha256:${n.repeat(64)}`;
/** The runs both runners plan: a member name and its plan digest. */
const RUNS: Record<string, string> = { "tenant-b": digest("b"), "tenant-a": digest("a"), "tenant-c": digest("c") };
const NOW = "2026-10-11T00:00:00Z";

async function throughOpWaves(): Promise<{ digest: string; gate: string; pending: string | undefined }> {
  const spec: OpWavesSpec = {
    name: "rollout",
    op: "migrate",
    plan: ["tool", "plan", "{target}", "--out", "{plan}"],
    apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
    waves: [{ name: "tenants", runs: Object.keys(RUNS).map((target) => ({ target })) }],
  };
  const cwd = mkdtempSync(join(tmpdir(), "wave-engine-"));
  try {
    const exec: OpWaveExec = (argv, dir) => {
      if (argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify({ planDigest: RUNS[argv[2]!] }));
      return 0;
    };
    const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(spec) });
    const gates = memoryGateLedgerPort();
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd, exec, show, gates, now: NOW });
    expect(result.exitCode).toBe(3);
    return { digest: result.decision!.digest, gate: result.decision!.gate, pending: gates.appended[0]?.planDigest };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function throughFanOut(): Promise<{ digest: string; gate: string; pending: string | undefined }> {
  const components: DriverComponent[] = Object.keys(RUNS).map((name) => ({ name, deploy: [{ phase: "Apply", steps: [] }] }));
  const plan = planFanOut({ components, changed: Object.keys(RUNS) });
  const gates = memoryGateLedgerPort();
  const result = await runFanOut(plan, components, new CapabilityRegistry(), {
    env: "prod",
    gates,
    now: NOW,
    waveGate: {
      op: "rollout",
      gate: "rollout",
      planComponent: async (component) => ({
        component: component.name,
        members: [{ member: component.name, planDigest: RUNS[component.name]! }],
        plans: {},
        parts: [],
      }),
    },
  });
  expect(result.status).toBe("gated");
  const wave = result.waves![0]!;
  return { digest: wave.digest, gate: wave.gate, pending: gates.appended[0]?.planDigest };
}

describe("one wave engine (#3766)", () => {
  test("the same runs bind the same set digest and gate through both runners", async () => {
    const expected = waveSetDigest(Object.entries(RUNS).map(([member, planDigest]) => ({ member, planDigest })));
    const op = await throughOpWaves();
    const fan = await throughFanOut();
    expect(op.digest).toBe(expected);
    expect(fan.digest).toBe(expected);
    expect(op.pending).toBe(expected);
    expect(fan.pending).toBe(expected);
    expect(op.gate).toBe("rollout-wave-1");
    expect(fan.gate).toBe(op.gate);
  });

  test("gate names: the default pattern is waveGateName's name, and a spec's pattern still wins", () => {
    for (const k of [1, 2, 12]) {
      expect(waveGateNameFrom(undefined, "deploy", k)).toBe(waveGateName("deploy", k));
      expect(waveGateNameFrom(WAVE_GATE_NAME_PATTERN, "deploy", k)).toBe(`deploy-wave-${k}`);
      expect(opWaveGateName({ name: "deploy" }, k)).toBe(waveGateName("deploy", k));
    }
    expect(opWaveGateName({ name: "x", gate: "tg", gateName: "wave-{k}" }, 3)).toBe("wave-3");
    expect(opWaveGateName({ name: "x", gateName: "{gate}/{k}" }, 3)).toBe("x/3");
  });

  test("the share split is the Op waves split by target", () => {
    const runs = ["t5", "t1", "t4", "t2", "t3"].map((target) => ({ target }));
    for (const shares of [1, 2, 3, 5]) {
      for (let share = 1; share <= shares; share++) {
        expect(waveShare(runs, share, shares, (r) => r.target)).toEqual(opWaveShare(runs, share, shares));
      }
    }
    expect(opWaveShare(runs, 1, 2).map((r) => r.target)).toEqual(["t1", "t2", "t3"]);
  });

  test("the loop: plan, digest, decide, apply per wave; a replan is bounded; onward walks on; an ended step skips the rest", async () => {
    const seen: string[] = [];
    type R = { k: number; replan?: boolean; stop?: boolean };
    const steps = (over: Partial<WaveLoopSteps<string, string, R>> = {}): WaveLoopSteps<string, string, R> => ({
      first: 2,
      async plan({ k, pass, prior }) {
        seen.push(`plan ${k}.${pass}${prior ? " after a replan" : ""}`);
        return k === 3 ? { end: { k } } : { go: `p${k}` };
      },
      digest: ({ k }, planned) => (seen.push(`digest ${k} of ${planned}`), `d${k}`),
      async decide({ k }, _planned, digest) {
        seen.push(`decide ${k} at ${digest}`);
        return { go: `g${k}` };
      },
      async apply({ k, pass }, planned, decided) {
        seen.push(`apply ${k} ${planned} ${decided}`);
        return { k, replan: k === 2 && pass === 0 };
      },
      replan: (_at, r) => r.replan === true,
      maxPasses: 2,
      onward: (k) => k < 4,
      ...over,
    });
    expect(await runWaveLoop(steps())).toEqual({ k: 4, replan: false });
    expect(seen).toEqual([
      "plan 2.0", "digest 2 of p2", "decide 2 at d2", "apply 2 p2 g2",
      "plan 2.1 after a replan", "digest 2 of p2", "decide 2 at d2", "apply 2 p2 g2",
      "plan 3.0",
      "plan 4.0", "digest 4 of p4", "decide 4 at d4", "apply 4 p4 g4",
    ]);

    seen.length = 0;
    const spent = await runWaveLoop(steps({ maxPasses: 1, onward: () => false, passesSpent: (_at, r) => ({ ...r, stop: true }) }));
    expect(spent).toEqual({ k: 2, replan: true, stop: true });
    expect(seen.filter((l) => l.startsWith("plan"))).toEqual(["plan 2.0"]);
  });
});
