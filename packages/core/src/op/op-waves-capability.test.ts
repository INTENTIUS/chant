/**
 * Op waves through capabilities (#4545): a spec's `step` plans and applies
 * each run through a capability in the job's process, and `holds` holds the
 * wave on a policy or a cost.
 */

import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpWavesSpec } from "./op-waves";
import { assertOpWavesSpec } from "./op-waves";
import { runOpWave, opWavePlanPath, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";
import { waveSetDigest } from "../gated-waves";
import { CapabilityRegistry, type Capability, type DeployContext } from "../components/capability";
import type { ChangeSetPart } from "../change-set";
import {
  OP_WAVE_COST_MEMBER,
  opWaveCostVerdict,
  opWaveHoldsAt,
  opWaveHoldsProblems,
  opWaveStepInput,
  opWaveStepProblems,
  partEffects,
  readCostEstimate,
} from "./op-waves-capability";

const digest = (n: string) => `sha256:${n.repeat(64)}`;

const part = (member: string, action: "create" | "delete" | "no-op"): ChangeSetPart => ({
  member: { member, lexicon: "terraform", planner: "chant", status: "planned", planDigest: digest("9"), holes: [] },
  entries: [{ member, address: `aws_s3_bucket.${member}`, type: "aws_s3_bucket", action } as ChangeSetPart["entries"][number]],
});

interface Calls {
  planned: Array<{ ctx: DeployContext; input: Record<string, unknown> }>;
  ran: Array<{ ctx: DeployContext; input: Record<string, unknown> }>;
}

/** A capability that plans each root to `digests[root]` and applies whatever plan it is handed, or refuses as moved. */
function fakeCapability(digests: Record<string, string>, opts: { moved?: string[]; action?: "create" | "delete" | "no-op" } = {}): { registry: CapabilityRegistry; calls: Calls } {
  const calls: Calls = { planned: [], ran: [] };
  const cap: Capability<Record<string, unknown>, unknown> = {
    kind: "fake-apply",
    async plan(ctx, input) {
      calls.planned.push({ ctx, input });
      const root = String(input.root);
      return { member: root, planDigest: digests[root]!, artifact: { planFile: `${root}.tfplan`, planJson: `${root}.tfplan.json` }, changeSet: part(root, opts.action ?? "create") };
    },
    async run(ctx, input) {
      calls.ran.push({ ctx, input });
      if (opts.moved?.includes(String(input.root))) throw Object.assign(new Error("the live system moved"), { planMoved: true });
      return { applied: input.root };
    },
  };
  return { registry: new CapabilityRegistry().register(cap), calls };
}

function harness(spec: OpWavesSpec) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-step-"));
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(spec) });
  return { cwd, show, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

const base: OpWavesSpec = {
  name: "roots",
  op: "tf-apply",
  step: { kind: "fake-apply", root: "{target}", lockTimeout: "5m" },
  waves: [{ name: "dev", runs: [{ target: "network" }, { target: "app", input: { vars: { size: "s" } } }], gate: "never" }],
};

describe("op waves through a capability step (#4545)", () => {
  test("each run plans through the step, and applies the plan it was given", async () => {
    const { registry, calls } = fakeCapability({ network: digest("1"), app: digest("2") });
    const h = harness(base);
    const result = await runOpWave({ spec: base, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates: memoryGateLedgerPort(), capabilities: registry });
    expect(result).toMatchObject({ exitCode: 0, applied: ["network", "app"], failed: [], moved: [] });
    expect(calls.planned.map((c) => c.input)).toEqual([
      { root: "network", lockTimeout: "5m" },
      { root: "app", lockTimeout: "5m", vars: { size: "s" } },
    ]);
    // #4613: the plan reads its policy packs at the wave's base.
    expect(calls.planned[0]!.ctx).toEqual({ env: "dev", component: "network", policyBase: "b".repeat(40) });
    // The apply gets the plan's artifact under the capability's member.
    expect(calls.ran[0]!.ctx.plans).toEqual({ network: { planFile: "network.tfplan", planJson: "network.tfplan.json" } });
    // The plan file hooks read carries the digest, the artifact and the part.
    const file = JSON.parse(readFileSync(join(h.cwd, opWavePlanPath(base, 1, "app")), "utf-8"));
    expect(file).toMatchObject({ planDigest: digest("2"), member: "app", artifact: { planFile: "app.tfplan" }, changeSet: { member: { member: "app" } } });
    h.done();
  });

  test("the wave's gate binds the step's digests, and the pending fact cites the composed change set", async () => {
    const spec: OpWavesSpec = { ...base, waves: [{ ...base.waves[0]!, gate: "always" }] };
    const { registry, calls } = fakeCapability({ network: digest("1"), app: digest("2") });
    const h = harness(spec);
    const stored: Array<{ digest: string; members: Array<{ member: string }> }> = [];
    const gates = Object.assign(memoryGateLedgerPort(), { storeChangeSet: async (doc: { digest: string; members: Array<{ member: string }> }) => void stored.push(doc) });
    const waiting = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates, capabilities: registry });
    expect(waiting.exitCode).toBe(3);
    expect(waiting.decision!.digest).toBe(waveSetDigest([{ member: "network", planDigest: digest("1") }, { member: "app", planDigest: digest("2") }]));
    expect(stored.map((d) => d.members.map((m) => m.member))).toEqual([["app", "network"]]);
    expect(waiting.decision!.changeSet).toBe(stored[0]!.digest);
    expect(calls.ran).toHaveLength(0);
    h.done();
  });

  test("a run the capability refuses as moved applies nothing and the job exits 4", async () => {
    const { registry } = fakeCapability({ network: digest("1"), app: digest("2") }, { moved: ["app"] });
    const h = harness(base);
    const result = await runOpWave({ spec: base, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates: memoryGateLedgerPort(), capabilities: registry });
    expect(result).toMatchObject({ exitCode: 4, applied: ["network"], moved: ["app"], failed: [] });
    h.done();
  });

  test("a destructive part makes the run destructive, which on-destructive waits on", async () => {
    const spec: OpWavesSpec = { ...base, waves: [{ ...base.waves[0]!, gate: "on-destructive" }] };
    const { registry } = fakeCapability({ network: digest("1"), app: digest("2") }, { action: "delete" });
    const h = harness(spec);
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates: memoryGateLedgerPort(), capabilities: registry });
    expect(result.exitCode).toBe(3);
    expect(result.decision!.members.every((m) => m.destructive)).toBe(true);
    h.done();
  });

  test("a cost over approveAbove holds a gate: never wave, and the cost is a member of the digest", async () => {
    const spec: OpWavesSpec = { ...base, holds: { cost: { command: ["infracost", "breakdown", "--path", "{planJson}"], approveAbove: 50, format: "chant" } } };
    const { registry } = fakeCapability({ network: digest("1"), app: digest("2") });
    const h = harness(spec);
    // planJson is relative to cwd and must exist; the fake's files do not, so the runs cannot be priced and the wave holds.
    const unpriced = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates: memoryGateLedgerPort(), capabilities: registry, holdExec: () => ({ status: 0, stdout: "{\"monthlyDelta\": 10}", stderr: "" }) });
    expect(unpriced.exitCode).toBe(3);
    expect(unpriced.decision!.heldBy!.join(" ")).toMatch(/could not be priced/);
    expect(unpriced.decision!.extras?.map((m) => m.member)).toEqual([OP_WAVE_COST_MEMBER]);
    h.done();
  });

  test("a cost under approveAbove lets a gate: never wave through", async () => {
    const spec: OpWavesSpec = { ...base, holds: { cost: { command: ["estimate", "{target}"], approveAbove: 50, format: "chant" } } };
    const { registry } = fakeCapability({ network: digest("1"), app: digest("2") });
    const h = harness(spec);
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates: memoryGateLedgerPort(), capabilities: registry, holdExec: () => ({ status: 0, stdout: "{\"monthlyDelta\": 10}", stderr: "" }) });
    expect(result).toMatchObject({ exitCode: 0, applied: ["network", "app"] });
    h.done();
  });

  test("a cost over approveAbove waits, whatever the gate", async () => {
    const spec: OpWavesSpec = { ...base, holds: { cost: { command: ["estimate", "{target}"], approveAbove: 15, format: "chant" } } };
    const { registry } = fakeCapability({ network: digest("1"), app: digest("2") });
    const h = harness(spec);
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates: memoryGateLedgerPort(), capabilities: registry, holdExec: () => ({ status: 0, stdout: "{\"monthlyDelta\": 10}", stderr: "" }) });
    expect(result.exitCode).toBe(3);
    expect(result.decision!.heldBy).toEqual(["cost: its monthly change of +20.00 USD is over holds.cost.approveAbove (15 USD)"]);
    h.done();
  });
});

describe("a policy hold over command plans (#4545)", () => {
  test("a plan file that gives no change set fails the wave, since the policy has nothing to read", async () => {
    const spec: OpWavesSpec = {
      name: "roots",
      op: "tf",
      plan: ["tool", "plan", "{target}", "--out", "{plan}"],
      apply: ["tool", "apply", "{target}"],
      holds: { policy: true },
      waves: [{ name: "dev", runs: [{ target: "vpc" }], gate: "never" }],
    };
    const h = harness(spec);
    const calls: string[] = [];
    const exec = (argv: string[], dir: string) => {
      calls.push(argv.join(" "));
      if (argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify({ planDigest: digest("1") }));
      return 0;
    };
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec, show: h.show, gates: memoryGateLedgerPort() });
    expect(result.exitCode).toBe(1);
    expect(calls.some((c) => c.startsWith("tool apply"))).toBe(false);
    h.done();
  });
});

describe("the step and holds settings (#4545)", () => {
  test("a step beside a plan command is refused", () => {
    expect(() => assertOpWavesSpec({ ...base, plan: ["tool", "plan", "{plan}"] })).toThrow(/`step` and `plan` are both set/);
    expect(opWaveStepProblems({ ...base, step: { kind: "" } })).toContain("`step.kind` must name a capability, such as \"terraform-apply\"");
  });

  test("a run's input fills its placeholders and lies over the step's", () => {
    const spec: OpWavesSpec = { ...base, step: { kind: "fake-apply", root: "{target}", cwd: "roots/{wave}", vars: { a: 1 } } };
    expect(opWaveStepInput(spec, { name: "prod" }, { target: "db", input: { vars: { b: "{op}" } } })).toEqual({ root: "db", cwd: "roots/prod", vars: { b: "tf-apply" } });
  });

  test("holds read at base win, and a policy hold is never dropped by a change", () => {
    expect(opWaveHoldsAt({ policy: true }, {})).toEqual({ policy: true });
    expect(opWaveHoldsAt(undefined, { policy: true })).toEqual({ policy: true });
    const cost = { command: ["x"], approveAbove: 10 };
    expect(opWaveHoldsAt({ cost }, { cost: { command: ["y"], approveAbove: 1e9 } })).toEqual({ cost });
    expect(opWaveHoldsAt(undefined, undefined)).toBeUndefined();
    expect(opWaveHoldsProblems({ cost: { command: [], approveAbove: -1 } })).toHaveLength(2);
    expect(opWaveHoldsProblems({ budget: 1 })).toEqual(["`holds.budget` is not a setting; the ones there are holds.policy and holds.cost"]);
  });

  test("estimates read in both formats, and the cost verdict sums them", () => {
    expect(readCostEstimate("infracost", JSON.stringify({ currency: "EUR", diffTotalMonthlyCost: "12.5" }))).toEqual({ monthlyDelta: 12.5, currency: "EUR" });
    expect(readCostEstimate("infracost", JSON.stringify({ totalMonthlyCost: "30", pastTotalMonthlyCost: "10" }))).toEqual({ monthlyDelta: 20 });
    expect(() => readCostEstimate("chant", "{}")).toThrow(/monthlyDelta/);
    const v = opWaveCostVerdict({ command: ["x"], approveAbove: 100 }, [{ target: "a", monthlyDelta: 40 }, { target: "b", monthlyDelta: 70 }]);
    expect(v).toMatchObject({ monthlyDelta: 110, currency: "USD", unestimated: [], hold: "cost: its monthly change of +110.00 USD is over holds.cost.approveAbove (100 USD)" });
    expect(opWaveCostVerdict({ command: ["x"], approveAbove: 100 }, [{ target: "a", monthlyDelta: 40 }]).hold).toBeUndefined();
  });

  test("a part's effects", () => {
    expect(partEffects(part("a", "no-op"))).toEqual({ empty: true, destructive: false });
    expect(partEffects(part("a", "delete"))).toEqual({ empty: false, destructive: true });
    expect(partEffects(undefined)).toEqual({ empty: false, destructive: false });
  });
});
