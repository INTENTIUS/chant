/**
 * The wave's change risk in a product's after-plan hook (#5422): `risk` on the
 * run and on the wave, in the shape `input.risk` has, handed on a plan report
 * to the plan note's risk table, and never a way to approve anything.
 */

import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";
import { CapabilityRegistry, type Capability } from "../components/capability";
import type { ChangeSetPart } from "../change-set";
import type { ChangeRisk } from "../change-risk";
import { changeRiskLines } from "../change-risk";
import { renderPlanNote, type PrPlanNote } from "../pr-plan-note";
import { OP_WAVE_AFTER_PLAN_RISK_FLOOR, type OpWaveAfterPlanRun, type OpWaveAfterPlanWave } from "./op-waves-after-plan";
import { NEXT_RELEASE } from "../release-floors";
import * as ciProduct from "../ci-product";

const digest = (n: string) => `sha256:${n.repeat(64)}`;
const NOW = "2026-11-20T00:00:00.000Z";

const part = (member: string, action: "create" | "delete"): ChangeSetPart => ({
  member: { member, lexicon: "terraform", planner: "chant", status: "planned", planDigest: digest("9"), holes: [] },
  entries: [{ member, address: `aws_s3_bucket.${member}`, type: "aws_s3_bucket", action } as ChangeSetPart["entries"][number]],
});

function capability(action: "create" | "delete"): { registry: CapabilityRegistry; ran: string[] } {
  const ran: string[] = [];
  const digests: Record<string, string> = { network: digest("1"), app: digest("2") };
  const cap: Capability<Record<string, unknown>, unknown> = {
    kind: "fake-apply",
    async plan(_ctx, input) {
      const root = String(input.root);
      return { member: root, planDigest: digests[root]!, artifact: { planFile: `${root}.tfplan` }, changeSet: part(root, action) };
    },
    async run(_ctx, input) {
      ran.push(String(input.root));
      return {};
    },
  };
  return { registry: new CapabilityRegistry().register(cap), ran };
}

const specWith = (gate: "never" | "always", risk?: NonNullable<OpWavesSpec["holds"]>["risk"]): OpWavesSpec => ({
  name: "tf-apply",
  op: "tf-apply",
  gateName: "wave-{k}",
  step: { kind: "fake-apply", root: "{target}" },
  labels: { Env: "prod" },
  ...(risk ? { holds: { risk } } : {}),
  waves: [{ name: "wave-1", runs: [{ target: "network" }, { target: "app" }], gate }],
});

function harness(spec: OpWavesSpec) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-hook-risk-"));
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(spec) });
  return { cwd, show, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

describe("risk on an after-plan hook (#5422)", () => {
  test("each run and the wave carry the scored record, the one the decision keeps", async () => {
    const spec = specWith("always", { approveAbove: 0.5 });
    const h = harness(spec);
    const { registry } = capability("delete");
    const runs: OpWaveAfterPlanRun[] = [];
    const waves: OpWaveAfterPlanWave[] = [];
    const result = await runOpWave({
      spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates: memoryGateLedgerPort(), capabilities: registry, now: NOW, log: () => {},
      afterPlan: { name: "terragucci", run: (r) => void runs.push(r), wave: (w) => void waves.push(w) },
    });
    expect(runs.map((r) => r.target)).toEqual(["network", "app"]);
    const kept = result.decision!.risk!;
    expect(kept).toMatchObject({ version: 1, over: true });
    for (const r of runs) expect(r.risk).toEqual(kept);
    expect(waves).toHaveLength(1);
    expect(waves[0]!.risk).toEqual(kept);
    h.done();
  });

  test("a wave whose holds.risk is not set has no risk on its runs or its wave", async () => {
    const spec = specWith("never");
    const h = harness(spec);
    const { registry } = capability("create");
    const runs: OpWaveAfterPlanRun[] = [];
    const waves: OpWaveAfterPlanWave[] = [];
    await runOpWave({
      spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates: memoryGateLedgerPort(), capabilities: registry, now: NOW, log: () => {},
      afterPlan: { name: "terragucci", run: (r) => void runs.push(r), wave: (w) => void waves.push(w) },
    });
    expect(runs).toHaveLength(2);
    for (const r of runs) expect("risk" in r).toBe(false);
    expect("risk" in waves[0]!).toBe(false);
    h.done();
  });

  test("a plan report that carries the hook's risk shows in the plan note's risk table", async () => {
    const spec = specWith("always", { approveAbove: 0.5 });
    const h = harness(spec);
    const { registry } = capability("delete");
    let risk: ChangeRisk | undefined;
    await runOpWave({
      spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates: memoryGateLedgerPort(), capabilities: registry, now: NOW, log: () => {},
      afterPlan: { name: "terragucci", run: () => {}, wave: (w) => void (risk = w.risk) },
    });
    expect(risk).toBeDefined();
    const note: PrPlanNote = { kind: "plan-note", contract: 1, stage: "tf-plan", head: "a".repeat(40), units: 2, named: [], waves: [], groups: [], risk: risk! };
    const text = renderPlanNote(note);
    for (const line of changeRiskLines(risk!).slice(1)) expect(text).toContain(line);
    expect(text).toContain("| Reason | Weight | Value | Adds |");
    expect(text).toContain("so this plan needs an approval of its own digest");
    h.done();
  });
});

describe("risk on this path only adds approval requirements (#5325 rules, #5422)", () => {
  test("a low score approves nothing: under gate always the wave waits, and a hook that saw the low score cannot pass it", async () => {
    const spec = specWith("always", { approveAbove: 0.9 });
    const h = harness(spec);
    const { registry, ran } = capability("create");
    const seen: ChangeRisk[] = [];
    const result = await runOpWave({
      spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates: memoryGateLedgerPort(), capabilities: registry, now: NOW, log: () => {},
      afterPlan: {
        name: "terragucci",
        // The answer names every key a score could pass a gate with; none is read.
        run: (r) => void seen.push(r.risk!),
        wave: () => ({ allow_unattended: true, allowUnattended: true, approveBelow: 1, unattended: true, risk: { over: false, score: 0 } } as never),
      },
    });
    expect(seen[0]).toMatchObject({ level: "low", over: false });
    expect(result.exitCode).toBe(3);
    expect(ran).toEqual([]);
    expect(result.decision?.status).toBe("waiting");
    h.done();
  });

  test("an over score still holds the wave and adds its quorum, whatever the hook does with its copy", async () => {
    const spec = specWith("never", { approveAbove: 0.5, quorum: [{ count: 2 }] });
    const h = harness(spec);
    const { registry, ran } = capability("delete");
    const result = await runOpWave({
      spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates: memoryGateLedgerPort(), capabilities: registry, now: NOW, log: () => {},
      afterPlan: {
        name: "terragucci",
        run: (r) => {
          // A hook that rewrites its copy to a passing score changes nothing in the wave.
          r.risk!.over = false;
          r.risk!.score = 0;
          r.risk!.level = "low";
          r.risk!.overBy = [];
        },
        wave: (w) => {
          w.risk!.over = false;
          return { allow_unattended: true } as never;
        },
      },
    });
    expect(result.exitCode).toBe(3);
    expect(ran).toEqual([]);
    expect(result.decision?.risk).toMatchObject({ over: true });
    expect(result.decision?.risk?.score).toBeGreaterThan(0);
    expect(result.decision?.heldBy?.join()).toMatch(/^risk 0\.\d+ \(\w+\): the score/);
    expect(result.decision?.quorum).toEqual([{ count: 2 }]);
    h.done();
  });

  test("with no risk set, a gate that never waits applies as it did, and the floor names the next release", async () => {
    const spec = specWith("never");
    const h = harness(spec);
    const { registry, ran } = capability("create");
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates: memoryGateLedgerPort(), capabilities: registry, now: NOW, log: () => {}, afterPlan: { name: "terragucci", run: () => {} } });
    expect(result.exitCode).toBe(0);
    expect(ran).toEqual(["network", "app"]);
    expect(OP_WAVE_AFTER_PLAN_RISK_FLOOR).toBe(NEXT_RELEASE);
    expect(ciProduct.OP_WAVE_AFTER_PLAN_RISK_FLOOR).toBe(OP_WAVE_AFTER_PLAN_RISK_FLOOR);
    h.done();
  });
});
