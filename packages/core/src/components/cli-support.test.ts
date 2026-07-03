/**
 * Tests for the CLI-facing component helpers (#560, epic #551): `listComponents`
 * (backs `chant list --components`), `describeComponent` (backs
 * `chant describe <name> --components`), and `computeComponentGraph` (backs
 * `chant graph --components`). Mirrors `../cli/commands/list.test.ts`'s style
 * of exercising the pure command function directly against a temp dir, rather
 * than going through the CLI arg-parsing/handler dispatch layer.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Ajv2020 from "ajv/dist/2020";
import componentSchema from "./component.schema.json";
import { listComponents, describeComponent, computeComponentGraph } from "./cli-support";

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
