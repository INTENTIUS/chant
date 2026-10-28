/**
 * After-plan hooks in the wave job's process (#4614): a product builds its
 * report, policy rows and plan files from chant's per-run plans.
 */

import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpWavesSpec } from "./op-waves";
import { assertOpWavesSpec } from "./op-waves";
import { runOpWave, opWavePlanPath, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";
import { CapabilityRegistry, type Capability } from "../components/capability";
import type { ChangeSetPart } from "../change-set";
import type { OpRunRecordInput } from "./runtime";
import { opWaveStepProblems } from "./op-waves-capability";
import {
  activeProductWaveHook,
  foldPolicyRows,
  opWaveAfterPlanProblems,
  opWaveAfterPlanResultProblems,
  withProductWaveHook,
  type OpWaveAfterPlanHook,
  type OpWaveAfterPlanRun,
} from "./op-waves-after-plan";
import { opWaveArgv } from "./stage-hooks";

const digest = (n: string) => `sha256:${n.repeat(64)}`;

const part = (member: string): ChangeSetPart => ({
  member: { member, lexicon: "terraform", planner: "chant", status: "planned", planDigest: digest("9"), holes: [] },
  entries: [{ member, address: `aws_s3_bucket.${member}`, type: "aws_s3_bucket", action: "create" } as ChangeSetPart["entries"][number]],
});

/** A capability whose plans name a plan document under `cwd`, as terraform-apply's `show -json` does. */
function capability(cwd: string, digests: Record<string, string>): { registry: CapabilityRegistry; ran: string[] } {
  const ran: string[] = [];
  const cap: Capability<Record<string, unknown>, unknown> = {
    kind: "fake-apply",
    async plan(_ctx, input) {
      const root = String(input.root);
      writeFileSync(join(cwd, `${root}.tfplan.json`), JSON.stringify({ resource_changes: [{ address: `aws_s3_bucket.${root}` }] }));
      return { member: root, planDigest: digests[root]!, artifact: { planFile: `${root}.tfplan`, planJson: `${root}.tfplan.json` }, changeSet: part(root) };
    },
    async run(_ctx, input) {
      ran.push(String(input.root));
      return { applied: input.root };
    },
  };
  return { registry: new CapabilityRegistry().register(cap), ran };
}

function harness(spec: OpWavesSpec) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-after-plan-"));
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(spec) });
  return { cwd, show, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

const spec: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  step: { kind: "fake-apply", root: "{target}" },
  waves: [{ name: "wave-1", runs: [{ target: "network" }, { target: "app" }, { target: "db" }], gate: "never" }],
};

const digests = { network: digest("1"), app: digest("2"), db: digest("3") };

describe("after-plan hooks in the job's process (#4614)", () => {
  test("a hook sees each run's plan once, in order, in a wave split into shares", async () => {
    const shared: OpWavesSpec = { ...spec, waves: [{ ...spec.waves[0]!, shares: 2 }] };
    const h = harness(shared);
    const { registry, ran } = capability(h.cwd, digests);
    const seen: OpWaveAfterPlanRun[] = [];
    const hook: OpWaveAfterPlanHook = { name: "report", run: (r) => void seen.push(r) };
    const result = await runOpWave({ spec: shared, specFile: "waves.json", wave: 1, decide: true, cwd: h.cwd, show: h.show, gates: memoryGateLedgerPort(), capabilities: registry, afterPlan: hook });
    expect(result.exitCode).toBe(0);
    expect(seen.map((r) => r.target)).toEqual(["network", "app", "db"]);
    expect(seen[0]).toMatchObject({
      spec: "tf-apply",
      wave: 1,
      waveName: "wave-1",
      job: "decide",
      planDigest: digest("1"),
      plan: opWavePlanPath(shared, 1, "network"),
      planJson: join(h.cwd, "network.tfplan.json"),
      artifact: { planFile: "network.tfplan" },
      changeSet: { member: { member: "network" } },
      empty: false,
      destructive: false,
      policy: [],
    });
    expect(result.hooks.filter((o) => o.moment === "after-plan").map((o) => [o.name, o.target, o.outcome])).toEqual([
      ["report", "network", "passed"],
      ["report", "app", "passed"],
      ["report", "db", "passed"],
    ]);
    // The deciding job applies nothing; its shares do.
    expect(ran).toEqual([]);
    h.done();
  });

  test("a hook that fails under onFailure fail stops the wave before the approval", async () => {
    const gated: OpWavesSpec = { ...spec, waves: [{ ...spec.waves[0]!, gate: "always" }] };
    const h = harness(gated);
    const { registry, ran } = capability(h.cwd, digests);
    const seen: string[] = [];
    const gates = memoryGateLedgerPort();
    const result = await runOpWave({
      spec: gated,
      specFile: "waves.json",
      wave: 1,
      cwd: h.cwd,
      show: h.show,
      gates,
      capabilities: registry,
      log: () => {},
      afterPlan: {
        name: "report",
        run: (r) => {
          seen.push(r.target);
          if (r.target === "app") throw new Error("the plan view cannot be written");
        },
      },
    });
    expect(result.exitCode).toBe(1);
    expect(seen).toEqual(["network", "app"]);
    expect(result.hooks.filter((o) => o.moment === "after-plan").map((o) => [o.target, o.outcome])).toEqual([["network", "passed"], ["app", "failed"]]);
    // No pending fact was recorded and nothing applied: the gate was never asked.
    expect(result.decision).toBeUndefined();
    expect(ran).toEqual([]);
    h.done();
  });

  test("a hook that fails under onFailure approve holds the wave for an approval", async () => {
    const h = harness(spec);
    const { registry, ran } = capability(h.cwd, digests);
    const result = await runOpWave({
      spec,
      specFile: "waves.json",
      wave: 1,
      cwd: h.cwd,
      show: h.show,
      gates: memoryGateLedgerPort(),
      capabilities: registry,
      log: () => {},
      afterPlan: { name: "steps", onFailure: "approve", targets: ["db"], run: () => { throw new Error("a step asks for a person"); } },
    });
    expect(result.exitCode).toBe(3);
    expect(result.decision?.heldBy).toEqual(["after-plan hook steps (db)"]);
    expect(ran).toEqual([]);
    h.done();
  });

  test("a product's denied row denies the run, and its rows and files go on the run record", async () => {
    const h = harness(spec);
    const { registry, ran } = capability(h.cwd, digests);
    const records: OpRunRecordInput[] = [];
    const result = await runOpWave({
      spec,
      specFile: "waves.json",
      wave: 1,
      cwd: h.cwd,
      show: h.show,
      gates: memoryGateLedgerPort(),
      runs: { append: async (r) => void records.push(r) },
      capabilities: registry,
      log: () => {},
      afterPlan: {
        name: "terragucci",
        run: (r) => ({
          policy: [{ source: "terragucci", result: r.target === "db" ? "denied" : "passed", rules: r.target === "db" ? ["main.deny_public"] : [] }],
          files: [`plans/${r.target}.json`],
        }),
      },
    });
    expect(result.exitCode).toBe(7);
    expect(result.decision?.refused?.runs).toEqual(["db"]);
    expect(result.decision?.members.find((m) => m.member === "db")?.denied).toEqual({ rules: ["main.deny_public"] });
    expect(ran).toEqual([]);
    expect(records[0]!.wave!.plans).toEqual({
      network: { planDigest: digest("1"), policy: [{ source: "terragucci", result: "passed", rules: [] }], files: ["plans/network.json"] },
      app: { planDigest: digest("2"), policy: [{ source: "terragucci", result: "passed", rules: [] }], files: ["plans/app.json"] },
      db: { planDigest: digest("3"), policy: [{ source: "terragucci", result: "denied", rules: ["main.deny_public"] }], files: ["plans/db.json"] },
    });
    h.done();
  });

  test("a command after.plan hook gets {planJson} and the plan's digest", async () => {
    const withHook: OpWavesSpec = { ...spec, hooks: { after: { plan: [{ name: "view", command: ["view", "{target}", "{plan}", "{planJson}"], perRun: true }] } } };
    expect(opWaveStepProblems(withHook)).toEqual([]);
    expect(() => assertOpWavesSpec(withHook)).not.toThrow();
    const h = harness(withHook);
    const { registry } = capability(h.cwd, digests);
    const calls: Array<{ argv: string[]; env?: Record<string, string> }> = [];
    const result = await runOpWave({
      spec: withHook,
      specFile: "waves.json",
      wave: 1,
      cwd: h.cwd,
      show: h.show,
      gates: memoryGateLedgerPort(),
      capabilities: registry,
      exec: (argv, _cwd, env) => (calls.push({ argv, ...(env ? { env } : {}) }), 0),
    });
    expect(result.exitCode).toBe(0);
    expect(calls.map((c) => c.argv)).toEqual(
      ["network", "app", "db"].map((t) => ["view", t, opWavePlanPath(withHook, 1, t), join(h.cwd, `${t}.tfplan.json`)]),
    );
    expect(calls[1]!.env).toMatchObject({ CHANT_TARGET: "app", CHANT_PLAN_DIGEST: digest("2"), CHANT_PLAN_JSON: join(h.cwd, "app.tfplan.json") });
    h.done();
  });

  test("a hook that runs once for the wave cannot name {planJson}", () => {
    expect(() => assertOpWavesSpec({ ...spec, hooks: { after: { plan: [{ command: ["view", "{planJson}"] }] } } })).toThrow(/runs once for the wave/);
    expect(() => assertOpWavesSpec({ ...spec, hooks: { before: { plan: [{ command: ["view", "{planJson}"], perRun: true }] } } })).toThrow(/before the plan/);
  });

  test("{plan} and {planJson} fill apart", () => {
    expect(opWaveArgv(["x", "{plan}", "{planJson}"], { op: "o", wave: "w", plan: "p.json", planJson: "p.tfplan.json" })).toEqual(["x", "p.json", "p.tfplan.json"]);
  });

  test("the hook list and its answers are checked", () => {
    expect(opWaveAfterPlanProblems({ name: "", run: 1, onFailure: "stop" })).toEqual([
      "afterPlan[0] needs a name",
      "afterPlan[0] needs a run function",
      'afterPlan[0] has onFailure "stop"; use fail or approve',
    ]);
    expect(opWaveAfterPlanResultProblems({ policy: [{ source: "x", result: "held", rules: [] }], files: ["../out"] })).toEqual([
      "policy[0] is held and names no rule, which an override or an approval would have to name",
      "`files` must be paths inside the job's directory, relative to it",
    ]);
    expect(opWaveAfterPlanResultProblems(undefined)).toEqual([]);
  });

  test("rows fold into the run's denial and hold", () => {
    expect(foldPolicyRows(
      [{ source: "p", result: "denied", rules: ["b"], reason: "public" }, { source: "p", result: "held", rules: ["h"] }, { source: "p", result: "passed", rules: [] }],
      { denied: { rules: ["a"] } },
    )).toEqual({ denied: { rules: ["a", "b"], reason: "public" }, held: { rules: ["h"] } });
  });

  test("a product's wave hook is active only while its command runs", async () => {
    const hook = { afterPlan: { name: "x", run: () => {} } };
    expect(activeProductWaveHook()).toBeUndefined();
    await withProductWaveHook(hook, async () => expect(activeProductWaveHook()).toBe(hook));
    expect(activeProductWaveHook()).toBeUndefined();
  });
});
