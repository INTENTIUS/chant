/**
 * `terraform-apply` (#3049): plan answers with the root and its #2300 digest,
 * and run applies the plan a wave approved rather than planning again.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

const calls: string[] = [];
let applyResult: Record<string, unknown> = { applied: true };
let changeSet: Record<string, unknown> | undefined;
let planJson: unknown;
// #3459: whether the root goes through choudoufu's set commands, and what they answer.
let waveRoot: { wave: true; root: string } | { wave: false; reason: string } = { wave: false, reason: "the root runs terraform" };
let waveApply: Record<string, unknown> = { exitCode: 0, landed: true, message: "landed" };
const waveApplyArgs: Array<Record<string, unknown>> = [];
// #4300: the targets each plan was asked for.
const planTargets: Array<string[] | undefined> = [];

vi.mock("../op/activities/terraform", () => ({
  choudoufuWaveRoot: vi.fn(async () => waveRoot),
  choudoufuPlanSet: vi.fn(async (args: { root: string }) => {
    calls.push(`plan-set ${args.root}`);
    return {
      setDigest: `sha256:set-${args.root}`,
      rootDigest: `sha256:root-${args.root}`,
      planDigest: `jcs1-sha256:${args.root}`,
      changed: true,
      json: planJson,
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
  terraformPlan: vi.fn(async (args: { root: string; vars?: Record<string, unknown>; targets?: string[] }) => {
    calls.push(`plan ${args.root} ${JSON.stringify(args.vars ?? {})}`);
    planTargets.push(args.targets);
    return { planFile: "chant.tfplan", planDigest: `jcs1-sha256:${args.root}`, json: planJson, ...(changeSet ? { changeSet } : {}) };
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

const { terraformApplyCapability, terraformCapabilityPlugin, terraformPlannedOutputs, TerraformPlanMovedError } = await import("./capability-plugin");
const { isPlanMovedError } = await import("@intentius/chant/components/capability");

beforeEach(() => {
  calls.length = 0;
  applyResult = { applied: true };
  changeSet = undefined;
  planJson = undefined;
  waveRoot = { wave: false, reason: "the root runs terraform" };
  waveApply = { exitCode: 0, landed: true, message: "landed" };
  waveApplyArgs.length = 0;
  planTargets.length = 0;
});

describe("terraform-apply targets (#4300)", () => {
  test("accepts targets, plans with them, and gives them back", async () => {
    expect(terraformApplyCapability.targets).toBe("accept");
    const planned = await terraformApplyCapability.plan!({ env: "test", component: "e01", targets: ["aws_vpc.main"] }, { root: "e01" });
    expect(planTargets).toEqual([["aws_vpc.main"]]);
    expect(planned.targets).toEqual(["aws_vpc.main"]);
  });

  test("a targeted choudoufu root plans with plan -target, never as a one-root set", async () => {
    waveRoot = { wave: true, root: "estates/e01" };
    await terraformApplyCapability.plan!({ env: "test", component: "e01", targets: ["aws_vpc.main"] }, { root: "e01" });
    expect(calls).toEqual(["init e01", "plan e01 {}"]);
  });

  test("run without a wave plan plans the targets before it applies", async () => {
    await terraformApplyCapability.run({ env: "test", component: "e01", targets: ["aws_vpc.main"] }, { root: "e01" });
    expect(planTargets).toEqual([["aws_vpc.main"]]);
  });

  test("a root waiting on inputs still gives the targets back", async () => {
    const planned = await terraformApplyCapability.plan!(
      { env: "test", component: "e01", targets: ["aws_vpc.main"], unresolvedInputs: ["net"] },
      { root: "e01", vars: { vpc: undefined } },
    );
    expect(planned.targets).toEqual(["aws_vpc.main"]);
  });
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

  test("a moved set throws core's plan-moved mark, so the command exits 3 (#3997)", async () => {
    waveApply = { exitCode: 3, landed: false, message: "choudoufu refused the approved set" };
    const err = await terraformApplyCapability
      .run({ env: "test", component: "e01", plans: { e01: wavePlan } }, { root: "e01" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TerraformPlanMovedError);
    expect(isPlanMovedError(err)).toBe(true);
  });

  test("a root that could not land is an ordinary failure, not a moved plan", async () => {
    waveApply = { exitCode: 4, landed: false, message: "choudoufu could not land the root" };
    const err = await terraformApplyCapability
      .run({ env: "test", component: "e01", plans: { e01: wavePlan } }, { root: "e01" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isPlanMovedError(err)).toBe(false);
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
      outputs: { known: {}, unknown: [] },
      shape: { member: "app", entries: [], unknownInputs: [] },
    });
    expect(calls).toEqual(["init app", 'plan app {"vpc":"v-1"}']);
  });

  test("plan returns the shape of the plan's show -json, on the plain path and the choudoufu set path (#4436)", async () => {
    planJson = {
      resource_changes: [
        { address: "terraform_data.keep", type: "terraform_data", change: { actions: ["no-op"] } },
        { address: "terraform_data.web", type: "terraform_data", change: { actions: ["create"], before: null, after: { input: "x" }, after_unknown: { id: true } } },
      ],
    };
    const expected = {
      member: "app",
      entries: [{ logicalId: "terraform_data.web", action: "create", type: "terraform_data", properties: ["id", "input"], unknown: ["id"] }],
      unknownInputs: [],
    };
    const plain = await terraformApplyCapability.plan!({ env: "test", component: "app" }, { root: "app" });
    expect(plain.shape).toEqual(expected);
    waveRoot = { wave: true, root: "estates/app" };
    const set = await terraformApplyCapability.plan!({ env: "test", component: "app" }, { root: "app" });
    expect(set.shape).toEqual(expected);
  });

  test("a root waiting on unknown outputs returns no shape, so it stays uncovered (#4436)", async () => {
    const planned = await terraformApplyCapability.plan!({ env: "test", component: "app", unresolvedInputs: ["net"] }, { root: "app", vars: { vpc: undefined } });
    expect(planned.shape).toBeUndefined();
  });

  test("plan answers the outputs the root will have, from the plan's planned values (#3999)", async () => {
    planJson = {
      planned_values: { outputs: { cidr: { sensitive: false, value: "10.1.0.0/16" }, id: { sensitive: false } } },
      output_changes: {
        cidr: { actions: ["update"], before: "10.0.0.0/16", after: "10.1.0.0/16", after_unknown: false },
        id: { actions: ["create"], before: null, after_unknown: true },
      },
    };
    const planned = await terraformApplyCapability.plan!({ env: "test", component: "net" }, { root: "net" });
    expect(planned.outputs).toEqual({ known: { cidr: "10.1.0.0/16" }, unknown: ["id"] });
    // The artifact `run` gets is still the plan file alone.
    expect(planned.artifact).toEqual({ planFile: "chant.tfplan", planDigest: "jcs1-sha256:net" });
  });

  test("a root whose vars read outputs not known yet is not planned: a hole names whose (#3999)", async () => {
    const ctx = { env: "test", component: "app", unresolvedInputs: ["net"] };
    const planned = await terraformApplyCapability.plan!(ctx, { root: "app", vars: { vpc: undefined, name: "app" } });
    expect(calls).toEqual([]);
    expect(planned.artifact).toBeUndefined();
    expect(planned.outputs).toBeUndefined();
    expect(planned.changeSet?.entries).toEqual([]);
    expect(planned.changeSet?.member.holes).toEqual([{ address: "app", type: "terraform_root", reason: "inputs from net; planned again once they apply" }]);
    expect(planned.planDigest).toBe(planned.changeSet?.member.planDigest);
    const again = await terraformApplyCapability.plan!(ctx, { root: "app", vars: { vpc: undefined, name: "app" } });
    expect(again.planDigest).toBe(planned.planDigest);
    const other = await terraformApplyCapability.plan!(ctx, { root: "app", vars: { vpc: undefined, name: "web" } });
    expect(other.planDigest).not.toBe(planned.planDigest);
  });
});

describe("terraformPlannedOutputs (#3999)", () => {
  test("an output is known when its planned value is there and nothing in it is unknown after apply", () => {
    expect(
      terraformPlannedOutputs({
        planned_values: { outputs: { a: { value: "x" }, b: { value: { k: 1 } }, c: {}, d: { value: null } } },
        output_changes: {
          a: { after: "x", after_unknown: false },
          b: { after: { k: 1 }, after_unknown: { k: false, j: true } },
          c: { after_unknown: true },
          d: { after: null, after_unknown: false },
        },
      }),
    ).toEqual({ known: { a: "x", d: null }, unknown: ["b", "c"] });
  });

  test("an output with no planned value and no change is unknown; a plan with no outputs has none", () => {
    expect(terraformPlannedOutputs({ planned_values: { outputs: { a: { sensitive: true } } } })).toEqual({ known: {}, unknown: ["a"] });
    expect(terraformPlannedOutputs({})).toEqual({ known: {}, unknown: [] });
    expect(terraformPlannedOutputs(undefined)).toEqual({ known: {}, unknown: [] });
  });
});

describe("terraform-apply, continued", () => {

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

  test.each(["approval-mismatch", "wrong-estate"])(
    "choudoufu's %s refusal of the wave's plan throws core's plan-moved mark, so the command exits 3 (#3997)",
    async (refused) => {
      applyResult = { applied: false, refused, refusal: "refused" };
      const err = await terraformApplyCapability
        .run({ env: "test", component: "app", plans: { app: { planFile: "chant.tfplan", planDigest: "d" } } }, { root: "app" })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TerraformPlanMovedError);
      expect(isPlanMovedError(err)).toBe(true);
    },
  );

  test("a refusal of a plan this run made itself is an ordinary failure: the next run plans afresh", async () => {
    applyResult = { applied: false, refused: "approval-mismatch", refusal: "refused" };
    const err = await terraformApplyCapability.run({ env: "test", component: "app" }, { root: "app" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isPlanMovedError(err)).toBe(false);
  });
});
