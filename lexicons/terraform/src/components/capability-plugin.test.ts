/**
 * `terraform-apply` (#3049): plan answers with the root and its #2300 digest,
 * and run applies the plan a wave approved rather than planning again.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

const calls: string[] = [];
let applyResult: Record<string, unknown> = { applied: true };
let changeSet: Record<string, unknown> | undefined;

vi.mock("../op/activities/terraform", () => ({
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
