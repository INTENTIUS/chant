import { describe, expect, test } from "vitest";
import { CapabilityRegistry, type DeployContext } from "./capability";
import { runInterpretDriver, type DriverComponent } from "./driver";
import { memoryGateLedgerPort } from "../op/gate";
import { PR_ENV_TEMPLATE_VAR, isPrEnvironmentName } from "./pr-environment";
import { NEXT_RELEASE } from "../release-floors";
import {
  GATE_ENVIRONMENTS_FLOOR,
  gateForEnvironment,
  skippedGatesOf,
  unknownGateEnvironments,
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
    expect(componentForEnvironment(plain, "prod")).toEqual({ component: plain, refusals: [], skippedGates: [] });
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

describe("a gate step applies only in the environments it names (#5401)", () => {
  const listed = { kind: "gate", gate: "release", environments: ["staging", "prod"] };
  const mapped = { kind: "gate", gate: "release", timeout: "48h", environments: { staging: { description: "staging sign-off" }, prod: { gate: "prod-release", timeout: "72h" } } };
  const network = (gate: Record<string, unknown>): DriverComponent => ({
    name: "network",
    deploy: [{ phase: "Apply", steps: [gate as never, terraform] }],
  });

  test("a list or a map applies the gate where it names, merging the entry, and skips it elsewhere", () => {
    expect(gateForEnvironment(listed, "staging")).toEqual({ step: { kind: "gate", gate: "release" } });
    expect(gateForEnvironment(listed, "dev")).toEqual({ skipped: { gate: "release", environments: ["staging", "prod"] } });
    expect(gateForEnvironment(mapped, "staging")).toEqual({ step: { kind: "gate", gate: "release", timeout: "48h", description: "staging sign-off" } });
    expect(gateForEnvironment(mapped, "prod")).toEqual({ step: { kind: "gate", gate: "prod-release", timeout: "72h" } });
    expect(gateForEnvironment(mapped, "dev")).toEqual({ skipped: { gate: "release", environments: ["staging", "prod"] } });
    // A pull request's environment takes its template's answer, as an engine step's entry does.
    expect(gateForEnvironment(listed, "pr-4", { template: "staging" })).toEqual({ step: { kind: "gate", gate: "release" } });
    expect(gateForEnvironment(listed, "pr-4", { template: "dev" })).toMatchObject({ skipped: { gate: "release" } });
  });

  test("a gate with no environments applies everywhere, and its component comes back as the same object", () => {
    const always = network({ kind: "gate", gate: "release" });
    const out = componentForEnvironment({ ...always, deploy: [{ phase: "Apply", steps: [{ kind: "gate", gate: "release" }] }] }, "dev");
    expect(out.skippedGates).toEqual([]);
    expect(out.component.deploy[0].steps).toEqual([{ kind: "gate", gate: "release" }]);
    const plain: DriverComponent = { name: "p", deploy: [{ phase: "Apply", steps: [{ kind: "gate", gate: "release" }] }] };
    expect(componentForEnvironment(plain, "dev").component).toBe(plain);
  });

  test("a skipped gate leaves its phase and is listed on it, and resolving again changes nothing", () => {
    const { component, skippedGates, refusals } = componentForEnvironment(network(listed), "staging");
    expect(refusals).toEqual([]);
    expect(skippedGates).toEqual([]);
    expect(component.deploy[0].steps[0]).toEqual({ kind: "gate", gate: "release" });

    const dev = componentForEnvironment<DriverComponent>({ ...network(listed), deploy: [{ phase: "Apply", steps: [listed as never, { kind: "apply" }] }] }, "dev");
    expect(dev.component.deploy[0].steps).toEqual([{ kind: "apply" }]);
    expect(dev.component.deploy[0].skippedGates).toEqual([{ gate: "release", environments: ["staging", "prod"] }]);
    expect(dev.skippedGates).toEqual([{ component: "network", phase: "Apply", gate: "release", environments: ["staging", "prod"] }]);
    expect(skippedGatesOf(dev.component)).toEqual(dev.skippedGates);
    expect(componentForEnvironment(dev.component, "dev").component).toBe(dev.component);
  });

  test("a malformed gate map is refused before anything runs", () => {
    expect(gateForEnvironment({ kind: "gate", gate: "g", environments: [] }, "dev")).toMatchObject({ error: expect.stringMatching(/takes a list of environment names/) });
    expect(gateForEnvironment({ kind: "gate", gate: "g", environments: ["prod", "prod"] }, "dev")).toMatchObject({ error: expect.stringMatching(/lists prod twice/) });
    expect(gateForEnvironment({ kind: "gate", gate: "g", environments: { prod: { root: "x" } } }, "dev")).toMatchObject({ error: expect.stringMatching(/sets `root` under prod/) });
    expect(() => componentsForEnvironment([network({ kind: "gate", gate: "g", environments: [""] })], "staging")).toThrow(/gate "g" step in phase "Apply" can't run in staging/);
  });

  test("the driver skips the gate where it does not apply and records the skip, and stops at it where it does", async () => {
    const registry = new CapabilityRegistry();
    registry.register({ kind: "terraform-apply", async run() { return {}; } } as never);
    const events: unknown[] = [];
    const staged = await runInterpretDriver([network(listed)], registry, {
      env: "staging",
      gates: memoryGateLedgerPort(),
    }).catch((e) => e.result);
    expect(staged.results[0].status).toBe("gated");

    const port = memoryGateLedgerPort();
    const component: DriverComponent = { name: "network", deploy: [{ phase: "Apply", steps: [listed as never, { kind: "terraform-apply" }] }] };
    const run = await runInterpretDriver([component], registry, { env: "dev", gates: port, onRunEvent: (e: unknown) => events.push(e) } as never);
    expect(run.results[0].status).toBe("ok");
    expect(port.appended).toEqual([]);
    expect(run.results[0].records[0]).toEqual({ component: "network", phase: "Apply", kind: "gate:release", status: "skipped", durationMs: 0, gateSkipped: { environments: ["staging", "prod"] } });
    expect(events).toContainEqual(expect.objectContaining({ type: "step-settle", step: "gate:release", status: "skipped", skip: "environment" }));
  });

  test("a gate that names an environment the member does not declare is reported for the build", () => {
    const declared = new Set(["dev", "staging", "prod"]);
    expect(unknownGateEnvironments([network(listed), network(mapped)], declared)).toEqual([]);
    expect(unknownGateEnvironments([network({ kind: "gate", gate: "release", environments: ["staging", "prdo"] })], declared)).toEqual([
      expect.objectContaining({ component: "network", gate: "release", unknown: ["prdo"], message: 'component "network": gate "release" in phase "Apply" names prdo in `environments`, and the member declares dev, prod, staging' }),
    ]);
    expect(unknownGateEnvironments([network(listed)], new Set())[0].message).toMatch(/the member declares no environments/);
    expect(unknownGateEnvironments([network({ kind: "gate", gate: "g", environments: {} })], declared)[0].message).toMatch(/takes a list of environment names/);
  });

  test("the floor names the next release", () => {
    expect(GATE_ENVIRONMENTS_FLOOR).toBe(NEXT_RELEASE);
  });
});
