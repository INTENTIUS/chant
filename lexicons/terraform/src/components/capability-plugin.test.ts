/**
 * `terraform-apply` (#3049): plan answers with the root and its #2300 digest,
 * and run applies the plan a wave approved rather than planning again.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

const calls: string[] = [];
let applyResult: Record<string, unknown> = { applied: true };
let changeSet: Record<string, unknown> | undefined;
// #3459: whether the root goes through choudoufu's set commands, and what they answer.
let waveRoot: { wave: true; root: string } | { wave: false; reason: string } = { wave: false, reason: "the root runs terraform" };
let waveApply: Record<string, unknown> = { exitCode: 0, landed: true, message: "landed" };
const waveApplyArgs: Array<Record<string, unknown>> = [];

vi.mock("../op/activities/terraform", () => ({
  choudoufuWaveRoot: vi.fn(async () => waveRoot),
  choudoufuPlanSet: vi.fn(async (args: { root: string }) => {
    calls.push(`plan-set ${args.root}`);
    return {
      setDigest: `sha256:set-${args.root}`,
      rootDigest: `sha256:root-${args.root}`,
      planDigest: `jcs1-sha256:${args.root}`,
      changed: true,
      json: {},
      changeSet: { member: { member: args.root, nativeDigest: `sha256:root-${args.root}` }, entries: [] },
      planSetFile: `/x/.chant/choudoufu-waves/${args.root}/plan-set.json`,
      root: `estates/${args.root}`,
    };
  }),
  choudoufuWaveApply: vi.fn(async (args: Record<string, unknown>) => {
    calls.push(`wave-apply ${String(args.root)} ${String(args.setDigest)}`);
    waveApplyArgs.push(args);
    return waveApply;
  }),
  terraformInit: vi.fn(async (args: { root: string }) => {
    calls.push(`init ${args.root}`);
    return { dir: `/x/${args.root}` };
  }),
  terraformPlan: vi.fn(async (args: { root: string; vars?: Record<string, unknown> }) => {
    calls.push(`plan ${args.root} ${JSON.stringify(args.vars ?? {})}`);
    return { planFile: "chant.tfplan", planDigest: `jcs1-sha256:${args.root}`, ...(changeSet ? { changeSet } : {}) };
  }),
  terraformApply: vi.fn(async (args: { root: string; planFile: string }) => {
    calls.push(`apply ${args.root} ${args.planFile}`);
    return { planFile: args.planFile, dir: `/x/${args.root}`, ...applyResult };
  }),
  terraformOutputs: vi.fn(async (args: { root: string }) => {
    calls.push(`output ${args.root}`);
    return { id: `${args.root}-id` };
  }),
}));

const { terraformApplyCapability, terraformCapabilityPlugin } = await import("./capability-plugin");

beforeEach(() => {
  calls.length = 0;
  applyResult = { applied: true };
  changeSet = undefined;
  waveRoot = { wave: false, reason: "the root runs terraform" };
  waveApply = { exitCode: 0, landed: true, message: "landed" };
  waveApplyArgs.length = 0;
});

describe("terraform-apply on a choudoufu root in a gated wave (#3459)", () => {
  const resume = { format_version: "1", set_digest: "sha256:set-e01", roots: [{ root: "estates/e01", wave: 1, outcome: "landed" }] };
  const carry = { kind: "choudoufu-wave-resume", setDigest: "sha256:set-e01", resume };
  const wavePlan = {
    planDigest: "jcs1-sha256:e01",
    choudoufu: { planSetFile: "/x/.chant/choudoufu-waves/e01/plan-set.json", setDigest: "sha256:set-e01" },
  };

  test("plan runs live-plan-set and binds chant's plan digest, keeping choudoufu's set digest for the apply", async () => {
    waveRoot = { wave: true, root: "estates/e01" };
    const planned = await terraformApplyCapability.plan!({ env: "test", component: "e01" }, { root: "e01" });
    expect(calls).toEqual(["plan-set e01"]);
    expect(planned.member).toBe("e01");
    expect(planned.planDigest).toBe("jcs1-sha256:e01");
    expect(planned.artifact).toEqual(wavePlan);
    expect(planned.changeSet).toEqual({ member: { member: "e01", nativeDigest: "sha256:root-e01" }, entries: [] });
  });

  test("a choudoufu root live-plan-set cannot plan as chant would keeps plan -out", async () => {
    waveRoot = { wave: false, reason: "the step passes -var values, which live-plan-set does not take" };
    await terraformApplyCapability.plan!({ env: "test", component: "e01" }, { root: "e01", vars: { a: "b" } });
    expect(calls).toEqual(["init e01", 'plan e01 {"a":"b"}']);
  });

  test("run hands the approved document and set digest to live-wave-apply and carries the resume file", async () => {
    waveApply = { exitCode: 0, landed: true, message: "landed", carry };
    const kept: Array<[string, unknown]> = [];
    const out = await terraformApplyCapability.run(
      { env: "test", component: "e01", plans: { e01: wavePlan }, carry: (m, v) => kept.push([m, v]) },
      { root: "e01" },
    );
    expect(calls).toEqual(["wave-apply e01 sha256:set-e01", "output e01"]);
    expect(waveApplyArgs[0]).toMatchObject({ root: "e01", planSetFile: wavePlan.choudoufu.planSetFile, setDigest: "sha256:set-e01" });
    expect(kept).toEqual([["e01", carry]]);
    expect(out).toEqual({ root: "e01", planDigest: "jcs1-sha256:e01", fromWavePlan: true, outputs: { id: "e01-id" } });
  });

  test("run passes what an earlier attempt carried for the root", async () => {
    await terraformApplyCapability.run(
      { env: "test", component: "e01", plans: { e01: wavePlan }, carried: { e01: carry, other: { x: 1 } } },
      { root: "e01" },
    );
    expect(waveApplyArgs[0]!.carried).toEqual(carry);
  });

  test("a moved set fails the step, applies nothing more, and still carries the resume file", async () => {
    waveApply = {
      exitCode: 3,
      landed: false,
      message: "choudoufu refused the approved set: the root's plan moved since it was approved, and nothing was applied",
      carry,
    };
    const kept: unknown[] = [];
    await expect(
      terraformApplyCapability.run(
        { env: "test", component: "e01", plans: { e01: wavePlan }, carry: (_m, v) => kept.push(v) },
        { root: "e01" },
      ),
    ).rejects.toThrow(/root "e01": choudoufu refused the approved set/);
    expect(calls).toEqual(["wave-apply e01 sha256:set-e01"]);
    expect(kept).toEqual([carry]);
  });
});

describe("terraform-apply", () => {
  test("the plugin contributes it", () => {
    expect(terraformCapabilityPlugin.capabilities().map((c) => c.kind)).toEqual(["terraform-apply"]);
  });

  test("plan inits and plans the root, with its vars, and names the root as the member", async () => {
    const planned = await terraformApplyCapability.plan!({ env: "test", component: "app" }, { root: "app", vars: { vpc: "v-1" } });
    expect(planned).toEqual({
      member: "app",
      planDigest: "jcs1-sha256:app",
      artifact: { planFile: "chant.tfplan", planDigest: "jcs1-sha256:app" },
    });
    expect(calls).toEqual(["init app", 'plan app {"vpc":"v-1"}']);
  });

  test("plan hands on the root's change-set part, outside the artifact run receives (#3183)", async () => {
    changeSet = { member: { member: "app" }, entries: [] };
    const planned = await terraformApplyCapability.plan!({ env: "test", component: "app" }, { root: "app" });
    expect(planned.changeSet).toEqual(changeSet);
    expect(planned.artifact).toEqual({ planFile: "chant.tfplan", planDigest: "jcs1-sha256:app" });
  });

  test("outputs inits the root and reads what its state exposes, planning nothing (#3183)", async () => {
    expect(await terraformApplyCapability.outputs!({ env: "test", component: "net" }, { root: "net" })).toEqual({ id: "net-id" });
    expect(calls).toEqual(["init net", "output net"]);
  });

  test("run applies the wave's plan file without planning again, and returns the root's outputs", async () => {
    const out = await terraformApplyCapability.run(
      { env: "test", component: "app", plans: { app: { planFile: "chant.tfplan", planDigest: "jcs1-sha256:app" } } },
      { root: "app" },
    );
    expect(calls).toEqual(["apply app chant.tfplan", "output app"]);
    expect(out).toEqual({ root: "app", planDigest: "jcs1-sha256:app", fromWavePlan: true, outputs: { id: "app-id" } });
  });

  test("run without a wave plan plans and applies in one go", async () => {
    const out = await terraformApplyCapability.run({ env: "test", component: "app" }, { root: "app" });
    expect(calls).toEqual(["init app", "plan app {}", "apply app chant.tfplan", "output app"]);
    expect(out.fromWavePlan).toBe(false);
  });

  test("a refused plan fails the step", async () => {
    applyResult = { applied: false, refused: "approval-mismatch", refusal: "The approved plan no longer matches the live system" };
    await expect(
      terraformApplyCapability.run(
        { env: "test", component: "app", plans: { app: { planFile: "chant.tfplan", planDigest: "d" } } },
        { root: "app" },
      ),
    ).rejects.toThrow(/refused the plan it was given \(approval-mismatch\)/);
    expect(calls).not.toContain("output app");
  });
});
