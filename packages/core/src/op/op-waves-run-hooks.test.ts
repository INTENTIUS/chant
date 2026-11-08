/**
 * Run hooks in the wave job's process (#4842): a product gives each run its
 * environment and checks, and acts before and after its apply, around
 * chant's step.
 */

import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";
import { CapabilityRegistry, type Capability, type DeployContext } from "../components/capability";
import type { ChangeSetPart } from "../change-set";
import type { OpRunRecordInput } from "./runtime";
import { opWaveRunHooksProblems, type OpWaveRunHookApplied, type OpWaveRunHooks } from "./op-waves-run-hooks";
import { activeProductWaveHook, withProductWaveHook } from "./op-waves-after-plan";

const digest = (n: string) => `sha256:${n.repeat(64)}`;

const part = (member: string): ChangeSetPart => ({
  member: { member, lexicon: "terraform", planner: "chant", status: "planned", planDigest: digest("9"), holes: [] },
  entries: [{ member, address: `aws_s3_bucket.${member}`, type: "aws_s3_bucket", action: "create" } as ChangeSetPart["entries"][number]],
});

interface Seen {
  planned: Array<{ root: string; env?: Record<string, string> }>;
  applied: Array<{ root: string; env?: Record<string, string> }>;
  order: string[];
}

function capability(digests: Record<string, string>, fail: string[] = []): { registry: CapabilityRegistry; seen: Seen } {
  const seen: Seen = { planned: [], applied: [], order: [] };
  const cap: Capability<Record<string, unknown>, unknown> = {
    kind: "fake-apply",
    async plan(ctx: DeployContext, input) {
      const root = String(input.root);
      seen.order.push(`init ${root}`);
      await ctx.afterInit?.();
      seen.order.push(`plan ${root}`);
      seen.planned.push({ root, ...(ctx.processEnv ? { env: ctx.processEnv } : {}) });
      return { member: root, planDigest: digests[root]!, artifact: { planFile: `${root}.tfplan` }, changeSet: part(root) };
    },
    async run(ctx: DeployContext, input) {
      const root = String(input.root);
      seen.order.push(`apply ${root}`);
      if (fail.includes(root)) throw new Error(`${root} did not apply`);
      seen.applied.push({ root, ...(ctx.processEnv ? { env: ctx.processEnv } : {}) });
      return { root, outputs: { id: `${root}-1` } };
    },
  };
  return { registry: new CapabilityRegistry().register(cap), seen };
}

const spec: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  step: { kind: "fake-apply", root: "{target}" },
  waves: [{ name: "wave-1", runs: [{ target: "network" }, { target: "app" }], gate: "never" }],
};

const digests = { network: digest("1"), app: digest("2") };

function harness(s: OpWavesSpec = spec) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-run-hooks-"));
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(s) });
  return { cwd, show, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

const run = (h: ReturnType<typeof harness>, registry: CapabilityRegistry, runHooks: OpWaveRunHooks | OpWaveRunHooks[], extra: { runs?: { append: (r: OpRunRecordInput) => Promise<void> }; spec?: OpWavesSpec } = {}) =>
  runOpWave({ spec: extra.spec ?? spec, specFile: "waves.json", wave: 1, cwd: h.cwd, show: h.show, gates: memoryGateLedgerPort(), capabilities: registry, log: () => {}, runHooks, ...(extra.runs ? { runs: extra.runs } : {}) });

describe("run hooks in the job's process (#4842)", () => {
  test("a run's env reaches its plan and its apply, the later hook's value winning", async () => {
    const h = harness();
    const { registry, seen } = capability(digests);
    const result = await run(h, registry, [
      { name: "roles", beforePlan: (r) => ({ env: { AWS_ROLE_ARN: `arn:${r.target}`, TF_VAR_x: "a" } }) },
      { name: "secrets", targets: ["app"], beforePlan: () => ({ env: { TF_VAR_x: "b" } }) },
    ]);
    expect(result.exitCode).toBe(0);
    expect(seen.planned).toEqual([
      { root: "network", env: { AWS_ROLE_ARN: "arn:network", TF_VAR_x: "a" } },
      { root: "app", env: { AWS_ROLE_ARN: "arn:app", TF_VAR_x: "b" } },
    ]);
    expect(seen.applied).toEqual(seen.planned);
    h.done();
  });

  test("a check after init runs between the engine's init and its plan, and a refusal there stops the wave", async () => {
    const h = harness();
    const { registry, seen } = capability(digests);
    // A run that cannot be planned fails the job, as a plan that fails does.
    await expect(run(h, registry, {
      name: "sources",
      beforePlan: (r) => ({
        afterInit: () => {
          seen.order.push(`check ${r.target}`);
          if (r.target === "app") throw new Error("module git::https://example.com/m is not on the list at base");
        },
      }),
    })).rejects.toThrow("planning app through fake-apply failed: the check after init of sources refused it: module git::https://example.com/m is not on the list at base");
    expect(seen.order).toEqual(["init network", "check network", "plan network", "init app", "check app"]);
    expect(seen.applied).toEqual([]);
    h.done();
  });

  test("a refusal before the plan stops the run before its engine starts, and nothing applies", async () => {
    const h = harness();
    const { registry, seen } = capability(digests);
    await expect(run(h, registry, { name: "sources", beforePlan: (r) => (r.target === "network" ? { refuse: "a module source outside the list at base" } : undefined) }))
      .rejects.toThrow("network was not planned: the before-plan hook sources refused it: a module source outside the list at base");
    expect(seen.order).toEqual([]);
    h.done();
  });

  test("a before-apply hook that throws fails its run, and the others apply", async () => {
    const h = harness();
    const { registry, seen } = capability(digests);
    const result = await run(h, registry, { name: "steps", beforeApply: (r) => { if (r.target === "network") throw new Error("tflint failed"); } });
    expect(result.exitCode).toBe(1);
    expect(result.failed).toEqual(["network"]);
    expect(result.applied).toEqual(["app"]);
    expect(seen.order).not.toContain("apply network");
    expect(result.targets?.network?.error).toContain("the before-apply hook steps failed, so nothing of it was applied: tflint failed");
    h.done();
  });

  test("an after-apply hook sees each outcome and output, its files go on the run record, and a throw after an apply fails the run", async () => {
    const h = harness();
    const { registry } = capability(digests, ["app"]);
    const got: OpWaveRunHookApplied[] = [];
    const records: OpRunRecordInput[] = [];
    const result = await run(h, registry, { name: "report", afterApply: (r) => (got.push(r), { files: [`states/${r.target}.json`] }) }, { runs: { append: async (r) => void records.push(r) } });
    expect(got.map((r) => [r.target, r.outcome, r.planDigest])).toEqual([["network", "applied", digests.network], ["app", "failed", digests.app]]);
    expect(got[0]!.output).toEqual({ root: "network", outputs: { id: "network-1" } });
    expect(got[1]!.reason).toContain("app did not apply");
    expect(result.exitCode).toBe(1);
    expect(records[0]!.wave!.targets?.network?.files).toEqual(["states/network.json"]);

    const again = harness();
    const ok = capability(digests);
    const thrown = await run(again, ok.registry, { name: "versions", targets: ["app"], afterApply: () => { throw new Error("the state version could not be read"); } });
    expect(thrown.exitCode).toBe(1);
    expect(thrown.applied).toEqual(["network"]);
    expect(thrown.failed).toEqual(["app"]);
    expect(thrown.targets?.app?.error).toContain("the after-apply hook versions failed: the state version could not be read");
    h.done();
    again.done();
  });

  test("runs applied at once take their hooks too", async () => {
    const wide: OpWavesSpec = { ...spec, parallelism: 2 };
    const h = harness(wide);
    const { registry, seen } = capability(digests);
    const after: string[] = [];
    const result = await run(h, registry, { name: "roles", beforePlan: (r) => ({ env: { ROLE: r.target } }), afterApply: (r) => void after.push(r.target) }, { spec: wide });
    expect(result.exitCode).toBe(0);
    expect(seen.applied.map((a) => a.env)).toEqual([{ ROLE: "network" }, { ROLE: "app" }]);
    expect(after.sort()).toEqual(["app", "network"]);
    h.done();
  });

  test("a product's wave hook hands its run hooks to the job", async () => {
    const hook = { runHooks: { name: "x", beforePlan: () => {} } };
    await withProductWaveHook(hook, async () => expect(activeProductWaveHook()?.runHooks).toBe(hook.runHooks));
  });

  test("the hook list is checked", async () => {
    expect(opWaveRunHooksProblems({ name: "", beforePlan: 1 })).toEqual(["runHooks[0] needs a name", "runHooks[0].beforePlan must be a function"]);
    expect(opWaveRunHooksProblems([{ name: "x" }])).toEqual(["runHooks[0] gives none of beforePlan, beforeApply and afterApply"]);
    const h = harness();
    const { registry } = capability(digests);
    await expect(run(h, registry, { name: "" } as OpWaveRunHooks)).rejects.toThrow(/runHooks\[0\] needs a name/);
    h.done();
  });

  test("the floor is the next release", async () => {
    const entry = await import("./index");
    const { NEXT_RELEASE } = await import("../release-floors");
    expect(entry.OP_WAVE_RUN_HOOKS_FLOOR).toBe(NEXT_RELEASE);
  });
});
