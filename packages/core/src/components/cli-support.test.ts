/**
 * Tests for the CLI-facing component helpers (#560, epic #551): `listComponents`
 * (backs `chant list --components`), `describeComponent` (backs
 * `chant describe <name> --components`), `computeComponentGraph` (backs
 * `chant graph --components`), and `runComponents` (backs `chant run
 * --components <name|all>`, #585). Mirrors `../cli/commands/list.test.ts`'s
 * style of exercising the pure command function directly against a temp dir,
 * rather than going through the CLI arg-parsing/handler dispatch layer.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Ajv2020 from "ajv/dist/2020";
import componentSchema from "./component.schema.json";
import { listComponents, describeComponent, computeComponentGraph, runComponents, findComponentGate } from "./cli-support";
import { CapabilityRegistry, type DeployContext } from "./capability";
import type { DriverComponent } from "./driver";

describe("listComponents", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-list-components-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("returns an empty, successful result for a directory with no components", async () => {
    const result = await listComponents(testDir);
    expect(result.success).toBe(true);
    expect(result.components).toEqual([]);
  });

  test("lists a discovered component with archetype inferred and phases in order", async () => {
    await writeFile(
      join(testDir, "orders.component.ts"),
      `
        export const ordersTable = {
          name: "orders-table",
          dependsOn: [],
          deploy: [
            { phase: "Apply", steps: [{ kind: "cfn-deploy" }] },
            { phase: "Verify", steps: [{ kind: "wait-for-stack" }] },
          ],
        };
      `,
    );

    const result = await listComponents(testDir);

    expect(result.success).toBe(true);
    expect(result.components).toHaveLength(1);
    expect(result.components[0]).toMatchObject({
      name: "orders-table",
      archetype: "infra",
      dependsOn: [],
      hasBuild: false,
      phases: ["Apply", "Verify"],
    });
    expect(result.components[0]!.filePath).toMatch(/orders\.component\.ts$/);
  });

  test("sorts components by name", async () => {
    await writeFile(
      join(testDir, "z.component.ts"),
      `export const zeta = { name: "zeta", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }] };`,
    );
    await writeFile(
      join(testDir, "a.component.ts"),
      `export const alpha = { name: "alpha", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }] };`,
    );

    const result = await listComponents(testDir);
    expect(result.components.map((c) => c.name)).toEqual(["alpha", "zeta"]);
  });

  test("reports hasBuild: true and the service archetype for a build + apply component", async () => {
    await writeFile(
      join(testDir, "svc.component.ts"),
      `
        export const svc = {
          name: "svc",
          dependsOn: [],
          build: { kind: "docker-build" },
          deploy: [
            { phase: "Publish", steps: [{ kind: "publish-image" }] },
            { phase: "Apply", steps: [{ kind: "ecs-update-service" }] },
          ],
        };
      `,
    );

    const result = await listComponents(testDir);
    expect(result.components[0]).toMatchObject({ hasBuild: true, archetype: "service" });
  });

  test("fails with discovery errors surfaced when a component file has a syntax error", async () => {
    await writeFile(join(testDir, "bad.component.ts"), `export const bad = { name: "bad"`);

    const result = await listComponents(testDir);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("describeComponent", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-describe-components-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("describes a component by its schema name, not its export name", async () => {
    await writeFile(
      join(testDir, "svc.component.ts"),
      `
        export const exportedAsThis = {
          name: "search-service",
          dependsOn: ["shared-alb"],
          build: { kind: "docker-build" },
          deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy" }] }],
        };
      `,
    );

    const result = await describeComponent(testDir, "search-service");

    expect(result.success).toBe(true);
    expect(result.described?.name).toBe("search-service");
    expect(result.described?.filePath).toMatch(/svc\.component\.ts$/);
    expect(result.described?.json).toMatchObject({
      name: "search-service",
      dependsOn: ["shared-alb"],
      archetype: "service",
    });
  });

  test("fails with a helpful message (listing known components) when the name is not found", async () => {
    await writeFile(
      join(testDir, "svc.component.ts"),
      `export const svc = { name: "known-one", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }] };`,
    );

    const result = await describeComponent(testDir, "nonexistent");

    expect(result.success).toBe(false);
    expect(result.described).toBeUndefined();
    expect(result.output).toContain("nonexistent");
    expect(result.output).toContain("known-one");
  });

  test("the JSON projection validates against component.schema.json", async () => {
    await writeFile(
      join(testDir, "svc.component.ts"),
      `
        export const svc = {
          name: "svc",
          dependsOn: [],
          deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", template: "t.json" }] }],
        };
      `,
    );

    const result = await describeComponent(testDir, "svc");
    expect(result.success).toBe(true);

    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validate = ajv.compile(componentSchema);
    expect(validate(result.described!.json)).toBe(true);
  });
});

describe("computeComponentGraph", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-graph-components-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("returns empty order/waves/edges for no components", async () => {
    const result = await computeComponentGraph(testDir);
    expect(result.success).toBe(true);
    expect(result.order).toEqual([]);
    expect(result.waves).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  test("orders a consumer after its producer, with a consumer → producer edge", async () => {
    await writeFile(
      join(testDir, "alb.component.ts"),
      `export const alb = { name: "shared-alb", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy" }] }] };`,
    );
    await writeFile(
      join(testDir, "svc.component.ts"),
      `export const svc = { name: "search-service", dependsOn: ["shared-alb"], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy" }] }] };`,
    );

    const result = await computeComponentGraph(testDir);

    expect(result.success).toBe(true);
    expect(result.order.indexOf("shared-alb")).toBeLessThan(result.order.indexOf("search-service"));
    expect(result.edges).toContainEqual({ from: "search-service", to: "shared-alb" });
    // Independent components share a wave; a dependent is in a strictly later wave.
    const albWave = result.waves.findIndex((w) => w.includes("shared-alb"));
    const svcWave = result.waves.findIndex((w) => w.includes("search-service"));
    expect(svcWave).toBeGreaterThan(albWave);
  });

  test("fails with a clear error on a dependency cycle", async () => {
    await writeFile(
      join(testDir, "a.component.ts"),
      `export const a = { name: "a", dependsOn: ["b"], deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }] };`,
    );
    await writeFile(
      join(testDir, "b.component.ts"),
      `export const b = { name: "b", dependsOn: ["a"], deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }] };`,
    );

    const result = await computeComponentGraph(testDir);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cycle/i);
  });

  test("fails with a clear error when dependsOn names an undiscovered component", async () => {
    await writeFile(
      join(testDir, "a.component.ts"),
      `export const a = { name: "a", dependsOn: ["ghost"], deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }] };`,
    );

    const result = await computeComponentGraph(testDir);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown component|ghost/i);
  });
});

// ── runComponents (#585) ─────────────────────────────────────────────────────

/** A fake capability that records every call and returns a canned output — mirrors ../driver.test.ts's `fakeCapability`. */
function fakeCapability(kind: string, opts?: { failRun?: boolean; output?: unknown }) {
  const calls: { ctx: DeployContext; input: unknown }[] = [];
  return {
    kind,
    async run(ctx: DeployContext, input: unknown) {
      calls.push({ ctx, input });
      if (opts?.failRun) throw new Error(`${kind} failed`);
      return opts?.output ?? { ok: true };
    },
    calls,
  };
}

/** A registry with one fake "shell"-like capability, `deploy-thing`, standing in for a real verb so tests don't hit the still-stubbed starter set. */
function fakeRegistry(opts?: { failRun?: boolean }): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.register(fakeCapability("deploy-thing", opts));
  return registry;
}

describe("findComponentGate", () => {
  test("returns undefined for a component with no gate", () => {
    const component: DriverComponent = {
      name: "svc",
      dependsOn: [],
      deploy: [{ phase: "Apply", steps: [{ kind: "deploy-thing" }] }],
    };
    expect(findComponentGate(component)).toBeUndefined();
  });

  test("finds a gate in a top-level deploy phase", () => {
    const component: DriverComponent = {
      name: "svc",
      dependsOn: [],
      deploy: [{ phase: "Approve", steps: [{ kind: "gate", signalName: "release-approval" }] }],
    };
    expect(findComponentGate(component)).toEqual({ kind: "gate", signalName: "release-approval" });
  });

  test("finds a gate nested inside a fan-out phase", () => {
    const component: DriverComponent = {
      name: "fleet",
      dependsOn: [],
      deploy: [
        {
          phase: "Rollout",
          steps: [
            {
              phase: "instance-2",
              steps: [{ kind: "gate", signalName: "instance-2-approval" }],
            },
          ],
        },
      ],
    };
    expect(findComponentGate(component)?.signalName).toBe("instance-2-approval");
  });

  test("finds a gate in a component's rollback phases", () => {
    const component: DriverComponent = {
      name: "svc",
      dependsOn: [],
      deploy: [{ phase: "Apply", steps: [{ kind: "deploy-thing" }] }],
      rollback: [{ phase: "Rollback", steps: [{ kind: "gate", signalName: "rollback-approval" }] }],
    };
    expect(findComponentGate(component)?.signalName).toBe("rollback-approval");
  });
});

describe("runComponents", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-run-components-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("runs a single named component through the driver", async () => {
    await writeFile(
      join(testDir, "svc.component.ts"),
      `export const svc = { name: "svc", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "deploy-thing" }] }] };`,
    );

    const registry = fakeRegistry();
    const result = await runComponents(testDir, "svc", { env: "staging", registry });

    expect(result.success).toBe(true);
    expect(result.selected).toEqual(["svc"]);
    expect(result.run?.ok).toBe(true);
    expect(result.run?.results).toHaveLength(1);
    expect(result.run?.results[0]).toMatchObject({ component: "svc", ok: true });
    expect(result.run?.results[0].records[0]).toMatchObject({ component: "svc", kind: "deploy-thing", status: "ok" });
  });

  test("threads --env into DeployContext", async () => {
    await writeFile(
      join(testDir, "svc.component.ts"),
      `export const svc = { name: "svc", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "deploy-thing" }] }] };`,
    );

    const capability = fakeCapability("deploy-thing");
    const registry = new CapabilityRegistry();
    registry.register(capability);

    await runComponents(testDir, "svc", { env: "prod", registry });

    expect(capability.calls).toHaveLength(1);
    expect(capability.calls[0].ctx.env).toBe("prod");
    expect(capability.calls[0].ctx.component).toBe("svc");
  });

  test("defaults --env to \"local\" when omitted", async () => {
    await writeFile(
      join(testDir, "svc.component.ts"),
      `export const svc = { name: "svc", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "deploy-thing" }] }] };`,
    );

    const capability = fakeCapability("deploy-thing");
    const registry = new CapabilityRegistry();
    registry.register(capability);

    await runComponents(testDir, "svc", { registry });

    expect(capability.calls[0].ctx.env).toBe("local");
  });

  test("runs a component whose dependsOn names infra outside the discovered set (no UnknownDependencyError)", async () => {
    await writeFile(
      join(testDir, "svc.component.ts"),
      `export const svc = { name: "search-service", dependsOn: ["shared-alb"], deploy: [{ phase: "Apply", steps: [{ kind: "deploy-thing" }] }] };`,
    );

    const registry = fakeRegistry();
    const result = await runComponents(testDir, "search-service", { registry });

    expect(result.success).toBe(true);
    expect(result.run?.ok).toBe(true);
  });

  test("all: dispatches every discovered component in wave order", async () => {
    await writeFile(
      join(testDir, "alb.component.ts"),
      `export const alb = { name: "shared-alb", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "deploy-thing" }] }] };`,
    );
    await writeFile(
      join(testDir, "svc.component.ts"),
      `export const svc = { name: "search-service", dependsOn: ["shared-alb"], deploy: [{ phase: "Apply", steps: [{ kind: "deploy-thing" }] }] };`,
    );

    const registry = fakeRegistry();
    const result = await runComponents(testDir, "all", { registry });

    expect(result.success).toBe(true);
    expect(result.selected.sort()).toEqual(["search-service", "shared-alb"]);
    expect(result.run?.waves).toEqual([["shared-alb"], ["search-service"]]);
    expect(result.run?.order).toEqual(["shared-alb", "search-service"]);
    expect(result.run?.results.every((r) => r.ok)).toBe(true);
  });

  test("all: fails clearly on a dependency cycle (no exception thrown)", async () => {
    await writeFile(
      join(testDir, "a.component.ts"),
      `export const a = { name: "a", dependsOn: ["b"], deploy: [{ phase: "Apply", steps: [{ kind: "deploy-thing" }] }] };`,
    );
    await writeFile(
      join(testDir, "b.component.ts"),
      `export const b = { name: "b", dependsOn: ["a"], deploy: [{ phase: "Apply", steps: [{ kind: "deploy-thing" }] }] };`,
    );

    const registry = fakeRegistry();
    const result = await runComponents(testDir, "all", { registry });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cycle/i);
  });

  test("unknown component name → clear error listing known components", async () => {
    await writeFile(
      join(testDir, "svc.component.ts"),
      `export const svc = { name: "svc", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "deploy-thing" }] }] };`,
    );

    const registry = fakeRegistry();
    const result = await runComponents(testDir, "missing", { registry });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Component "missing" not found');
    expect(result.error).toContain("svc");
  });

  test("a gate in the selected component is rejected before any step runs", async () => {
    await writeFile(
      join(testDir, "svc.component.ts"),
      `export const svc = { name: "svc", dependsOn: [], deploy: [
        { phase: "Approve", steps: [{ kind: "gate", signalName: "release-approval" }] },
        { phase: "Apply", steps: [{ kind: "deploy-thing" }] },
      ] };`,
    );

    const capability = fakeCapability("deploy-thing");
    const registry = new CapabilityRegistry();
    registry.register(capability);

    const result = await runComponents(testDir, "svc", { registry });

    expect(result.success).toBe(false);
    expect(result.gateUnsupported).toEqual({ component: "svc", signalName: "release-approval" });
    // Pre-flighted: the deploy-thing step after the gate never ran.
    expect(capability.calls).toHaveLength(0);
  });

  test("a failing step surfaces a failed component result, not a thrown exception", async () => {
    await writeFile(
      join(testDir, "svc.component.ts"),
      `export const svc = { name: "svc", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "deploy-thing" }] }] };`,
    );

    const registry = fakeRegistry({ failRun: true });
    const result = await runComponents(testDir, "svc", { registry });

    expect(result.success).toBe(false);
    expect(result.run?.ok).toBe(false);
    expect(result.run?.failedComponent).toBe("svc");
    expect(result.run?.results[0].records[0]).toMatchObject({ status: "fail" });
  });

  test("discovery error surfaces as a failure, not an exception", async () => {
    await writeFile(join(testDir, "broken.component.ts"), `export const broken = notDefined;`);

    const result = await runComponents(testDir, "all");

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
