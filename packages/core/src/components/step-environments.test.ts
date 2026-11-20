import { describe, expect, test } from "vitest";
import { CapabilityRegistry, type DeployContext } from "./capability";
import { runInterpretDriver, type DriverComponent } from "./driver";
import { memoryGateLedgerPort } from "../op/gate";
import { PR_ENV_TEMPLATE_VAR, isPrEnvironmentName } from "./pr-environment";
import { NEXT_RELEASE } from "../release-floors";
import {
  STEP_ENVIRONMENTS_FLOOR,
  StepEnvironmentRefusedError,
  componentForEnvironment,
  componentsForEnvironment,
  stepForEnvironment,
  stepInputForEnvironment,
} from "./step-environments";

const pulumi = {
  kind: "pulumi-up",
  dir: "infra/shop",
  config: { "shop:size": "small" },
  environments: {
    dev: { stack: "acme/shop/dev" },
    staging: { stack: "acme/shop/staging" },
    prod: { stack: "acme/shop/prod", config: { "shop:size": "large" } },
  },
};

const terraform = {
  kind: "terraform-apply",
  vars: { region: "us-east-1" },
  environments: {
    staging: { root: "envs/staging/network" },
    prod: { root: "envs/prod/network", vars: { region: "us-east-2" } },
  },
};

const shop: DriverComponent = { name: "shop", deploy: [{ phase: "Apply", steps: [pulumi] }] };
const network: DriverComponent = { name: "network", deploy: [{ phase: "Apply", steps: [terraform] }] };

describe("a step's inputs per environment (#5360)", () => {
  test("the entry for the environment replaces the step's own keys, and the map is removed", () => {
    expect(stepForEnvironment(pulumi, "staging")).toEqual({ step: { kind: "pulumi-up", dir: "infra/shop", config: { "shop:size": "small" }, stack: "acme/shop/staging" } });
    expect(stepForEnvironment(pulumi, "prod")).toEqual({ step: { kind: "pulumi-up", dir: "infra/shop", config: { "shop:size": "large" }, stack: "acme/shop/prod" } });
    expect(stepForEnvironment(terraform, "prod")).toEqual({ step: { kind: "terraform-apply", root: "envs/prod/network", vars: { region: "us-east-2" } } });
    expect(stepForEnvironment(terraform, "staging")).toEqual({ step: { kind: "terraform-apply", root: "envs/staging/network", vars: { region: "us-east-1" } } });
  });

  test("a step without the map comes back as the same object, and so does a component with none", () => {
    const fixed = { kind: "pulumi-up", dir: "infra", stack: "acme/shop/dev" };
    expect(stepForEnvironment(fixed, "prod")).toEqual({ step: fixed });
    expect((stepForEnvironment(fixed, "prod") as { step: unknown }).step).toBe(fixed);
    const plain: DriverComponent = { name: "plain", deploy: [{ phase: "Apply", steps: [fixed] }] };
    expect(componentForEnvironment(plain, "prod")).toEqual({ component: plain, refusals: [] });
    expect(componentForEnvironment(plain, "prod").component).toBe(plain);
  });

  test("an environment the step does not name is refused, listing the environments it names", () => {
    expect(stepForEnvironment(terraform, "dev")).toEqual({ error: "its `environments` names staging, prod, and not dev", named: ["staging", "prod"] });
    expect(() => componentsForEnvironment([shop, network], "dev")).toThrow(StepEnvironmentRefusedError);
    try {
      componentsForEnvironment([shop, network], "qa");
    } catch (err) {
      const refusals = (err as StepEnvironmentRefusedError).refusals;
      expect(refusals.map((r) => [r.component, r.kind, r.named])).toEqual([
        ["shop", "pulumi-up", ["dev", "staging", "prod"]],
        ["network", "terraform-apply", ["staging", "prod"]],
      ]);
      expect((err as Error).message).toContain('component "network": its terraform-apply step in phase "Apply" can\'t run in qa: its `environments` names staging, prod, and not qa');
    }
    expect(() => stepInputForEnvironment(terraform, "dev", { component: "network", phase: "Apply", kind: "terraform-apply" })).toThrow(/names staging, prod, and not dev/);
  });

  test("a malformed map is refused by what is wrong with it", () => {
    expect(stepForEnvironment({ kind: "x", environments: {} }, "dev")).toMatchObject({ error: expect.stringMatching(/takes a map from environment name/) });
    expect(stepForEnvironment({ kind: "x", environments: { dev: "acme/dev" } }, "dev")).toMatchObject({ error: expect.stringMatching(/names dev with string/) });
    expect(stepForEnvironment({ kind: "x", environments: { dev: { kind: "y" } } }, "dev")).toMatchObject({ error: expect.stringMatching(/sets `kind` under dev/) });
  });

  test("every phase is resolved: nested phases, onFailure, verify and rollback, and gates are left alone", () => {
    const gate = { kind: "gate", gate: "prod-ok" };
    const component = {
      name: "shop",
      deploy: [{ phase: "Apply", steps: [gate, { phase: "Inner", steps: [pulumi] }], onFailure: [{ phase: "Undo", steps: [terraform] }] }],
      verify: [{ phase: "Check", steps: [{ kind: "health", environments: { prod: { url: "https://shop" } } }] }],
      rollback: [{ phase: "Back", steps: [terraform] }],
    };
    const { component: out, refusals } = componentForEnvironment(component, "prod");
    expect(refusals).toEqual([]);
    expect(out.deploy[0].steps[0]).toBe(gate);
    expect((out.deploy[0].steps[1] as { steps: unknown[] }).steps[0]).toMatchObject({ stack: "acme/shop/prod" });
    expect(out.deploy[0].onFailure![0].steps[0]).toMatchObject({ root: "envs/prod/network" });
    expect(out.verify![0].steps[0]).toEqual({ kind: "health", url: "https://shop" });
    expect(out.rollback![0].steps[0]).toMatchObject({ root: "envs/prod/network" });
    expect(component.deploy[0].steps[1]).toEqual({ phase: "Inner", steps: [pulumi] });
  });

  test("a pull request's environment takes its template environment's entry, by name or by a stack's last segment", () => {
    expect(stepForEnvironment(pulumi, "pr-12", { template: "dev" })).toMatchObject({ step: { stack: "acme/shop/dev" } });
    expect(stepForEnvironment(pulumi, "pr-12", { processEnv: { CHANT_ENV_TEMPLATE: "staging" } })).toMatchObject({ step: { stack: "acme/shop/staging" } });
    expect(stepForEnvironment(pulumi, "pr-12", { template: "shop/dev" })).toMatchObject({ step: { stack: "acme/shop/dev" } });
    expect(stepForEnvironment(pulumi, "pr-12", { processEnv: {} })).toMatchObject({ error: "its `environments` names dev, staging, prod, and not pr-12" });
    expect(stepForEnvironment(pulumi, "pr-12", { template: "qa" })).toMatchObject({ error: "its `environments` names dev, staging, prod, and not pr-12, nor its template qa" });
    // Only a pull request's environment reads the template.
    expect(stepForEnvironment(pulumi, "qa", { template: "dev" })).toMatchObject({ error: expect.any(String) });
    expect(PR_ENV_TEMPLATE_VAR).toBe("CHANT_ENV_TEMPLATE");
    expect(isPrEnvironmentName("pr-12")).toBe(true);
  });

  test("the driver hands each capability its environment's inputs, and refuses an unnamed environment before anything runs", async () => {
    const seen: Array<{ env: string; kind: string; input: unknown }> = [];
    const registry = new CapabilityRegistry();
    for (const kind of ["pulumi-up", "terraform-apply"]) {
      registry.register({ kind, async run(ctx: DeployContext, input: unknown) { seen.push({ env: ctx.env, kind, input }); return {}; } } as never);
    }
    await runInterpretDriver([network, { ...shop, dependsOn: ["network"] }], registry, { env: "staging", gates: memoryGateLedgerPort() });
    expect(seen).toEqual([
      { env: "staging", kind: "terraform-apply", input: { root: "envs/staging/network", vars: { region: "us-east-1" } } },
      { env: "staging", kind: "pulumi-up", input: { dir: "infra/shop", config: { "shop:size": "small" }, stack: "acme/shop/staging" } },
    ]);
    seen.length = 0;
    await expect(runInterpretDriver([shop, network], registry, { env: "dev", gates: memoryGateLedgerPort() })).rejects.toThrow(/terraform-apply step in phase "Apply" can't run in dev: its `environments` names staging, prod/);
    expect(seen).toEqual([]);
  });

  test("the floor names the next release", () => {
    expect(STEP_ENVIRONMENTS_FLOOR).toBe(NEXT_RELEASE);
  });
});
