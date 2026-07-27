/**
 * Discovery tests for the typed `Component` authoring form (#560, epic #551).
 *
 * Mirrors `../discovery/index.test.ts`'s style (write real `.ts` fixture
 * files to a temp dir, run the discovery entrypoint, assert on the returned
 * map) rather than `../op/discover.test.ts`'s (which discovers from the git
 * root against real example files) since `discoverComponents`, like
 * `discover()`, takes an explicit path rather than always walking from the
 * repo root.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { discoverComponents } from "./discover";
import { params } from "../params";

describe("discoverComponents", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-component-discover-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("returns empty result for an empty directory", async () => {
    const result = await discoverComponents(testDir);
    expect(result.components.size).toBe(0);
    expect(result.sourceFiles).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("discovers a component from a single *.component.ts file", async () => {
    await writeFile(
      join(testDir, "search.component.ts"),
      `
        export const searchService = {
          name: "search-service",
          dependsOn: [],
          deploy: [{ phase: "Apply", steps: [{ kind: "shell", command: "echo ok" }] }],
        };
      `,
    );

    const result = await discoverComponents(testDir);

    expect(result.errors).toEqual([]);
    expect(result.components.size).toBe(1);
    expect(result.components.has("search-service")).toBe(true);
    expect(result.components.get("search-service")?.exportName).toBe("searchService");
    expect(result.sourceFiles).toHaveLength(1);
    expect(result.sourceFiles[0]).toMatch(/search\.component\.ts$/);
  });

  test("discovers multiple components across multiple files, keyed by component.name not export name", async () => {
    await writeFile(
      join(testDir, "a.component.ts"),
      `
        export const foo = {
          name: "svc-a",
          dependsOn: [],
          deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
        };
      `,
    );
    await writeFile(
      join(testDir, "b.component.ts"),
      `
        export const bar = {
          name: "svc-b",
          dependsOn: ["svc-a"],
          deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
        };
      `,
    );

    const result = await discoverComponents(testDir);

    expect(result.errors).toEqual([]);
    expect(result.components.size).toBe(2);
    expect([...result.components.keys()].sort()).toEqual(["svc-a", "svc-b"]);
    expect(result.sourceFiles).toHaveLength(2);
  });

  test("discovers multiple components exported from one file (any export name, not just default)", async () => {
    await writeFile(
      join(testDir, "multi.component.ts"),
      `
        export const first = {
          name: "first-comp",
          dependsOn: [],
          deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
        };
        export const second = {
          name: "second-comp",
          dependsOn: [],
          deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
        };
      `,
    );

    const result = await discoverComponents(testDir);

    expect(result.errors).toEqual([]);
    expect(result.components.size).toBe(2);
    expect(result.components.has("first-comp")).toBe(true);
    expect(result.components.has("second-comp")).toBe(true);
  });

  test("ignores non-.component.ts files, even if they export a Component-shaped value", async () => {
    await writeFile(
      join(testDir, "not-a-component.ts"),
      `
        export const sneaky = {
          name: "sneaky",
          dependsOn: [],
          deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
        };
      `,
    );

    const result = await discoverComponents(testDir);

    expect(result.components.size).toBe(0);
    expect(result.sourceFiles).toEqual([]);
  });

  test("excludes .test.component.ts / .spec.component.ts files", async () => {
    await writeFile(
      join(testDir, "real.component.ts"),
      `
        export const real = {
          name: "real",
          dependsOn: [],
          deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
        };
      `,
    );
    await writeFile(
      join(testDir, "fixture.test.component.ts"),
      `
        export const testOnly = {
          name: "test-only",
          dependsOn: [],
          deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
        };
      `,
    );

    const result = await discoverComponents(testDir);

    expect(result.components.size).toBe(1);
    expect(result.components.has("real")).toBe(true);
    expect(result.components.has("test-only")).toBe(false);
    expect(result.sourceFiles).toHaveLength(1);
  });

  test("ignores non-Component-shaped exports from a *.component.ts file", async () => {
    await writeFile(
      join(testDir, "mixed.component.ts"),
      `
        export const realComponent = {
          name: "real-component",
          dependsOn: [],
          deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
        };
        export const helper = { foo: "bar" };
        export const CONST = 42;
      `,
    );

    const result = await discoverComponents(testDir);

    expect(result.components.size).toBe(1);
    expect(result.components.has("real-component")).toBe(true);
  });

  test("recurses into nested directories", async () => {
    const subDir = join(testDir, "services", "search");
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, "search.component.ts"),
      `
        export const searchService = {
          name: "search-service",
          dependsOn: [],
          deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
        };
      `,
    );

    const result = await discoverComponents(testDir);

    expect(result.components.size).toBe(1);
    expect(result.components.has("search-service")).toBe(true);
    expect(result.sourceFiles[0]).toMatch(/search\.component\.ts$/);
  });

  test("skips node_modules", async () => {
    const nm = join(testDir, "node_modules", "some-pkg");
    await mkdir(nm, { recursive: true });
    await writeFile(
      join(nm, "vendored.component.ts"),
      `
        export const vendored = {
          name: "vendored",
          dependsOn: [],
          deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
        };
      `,
    );

    const result = await discoverComponents(testDir);

    expect(result.components.size).toBe(0);
    expect(result.sourceFiles).toEqual([]);
  });

  test("reports a duplicate component name across two files as a resolution error", async () => {
    await writeFile(
      join(testDir, "one.component.ts"),
      `
        export const svc = {
          name: "dup",
          dependsOn: [],
          deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
        };
      `,
    );
    await writeFile(
      join(testDir, "two.component.ts"),
      `
        export const svcAgain = {
          name: "dup",
          dependsOn: [],
          deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
        };
      `,
    );

    const result = await discoverComponents(testDir);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.type).toBe("resolution");
    expect(result.errors[0]?.message).toMatch(/Duplicate component name "dup"/);
    // The first one found is kept; discovery continues rather than aborting.
    expect(result.components.has("dup")).toBe(true);
  });

  test("collects an import error (syntax error) and continues processing other files", async () => {
    await writeFile(
      join(testDir, "good.component.ts"),
      `
        export const good = {
          name: "good",
          dependsOn: [],
          deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
        };
      `,
    );
    await writeFile(
      join(testDir, "bad.component.ts"),
      `
        export const bad = {
          name: "bad"
          dependsOn: [],
        };
      `,
    );

    const result = await discoverComponents(testDir);

    expect(result.components.has("good")).toBe(true);
    expect(result.errors.some((e) => e.type === "import")).toBe(true);
  });

  test("the first chant.config.ts encountered becomes the source root and is still scanned", async () => {
    // Matches findInfraFiles's own rule: the *first* config directory found
    // becomes `sourceRoot` and is descended into, same as any other
    // directory — the skip only applies to a *second* nested config found
    // after that (see the next test).
    const childDir = join(testDir, "child-project");
    await mkdir(childDir, { recursive: true });
    await writeFile(join(childDir, "chant.config.ts"), `export default {};`);
    await writeFile(
      join(childDir, "child.component.ts"),
      `
        export const childSvc = {
          name: "child-svc",
          dependsOn: [],
          deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
        };
      `,
    );
    await writeFile(
      join(testDir, "root.component.ts"),
      `
        export const rootSvc = {
          name: "root-svc",
          dependsOn: [],
          deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
        };
      `,
    );

    const result = await discoverComponents(testDir);

    expect(result.components.has("root-svc")).toBe(true);
    expect(result.components.has("child-svc")).toBe(true);
  });

  test("a second nested chant.config.ts (a true child project) is not descended into", async () => {
    const firstConfigDir = join(testDir, "first-config");
    const nestedChildProject = join(firstConfigDir, "nested-child-project");
    await mkdir(nestedChildProject, { recursive: true });
    await writeFile(join(firstConfigDir, "chant.config.ts"), `export default {};`);
    await writeFile(join(nestedChildProject, "chant.config.ts"), `export default {};`);
    await writeFile(
      join(firstConfigDir, "first.component.ts"),
      `
        export const firstSvc = {
          name: "first-svc",
          dependsOn: [],
          deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
        };
      `,
    );
    await writeFile(
      join(nestedChildProject, "nested.component.ts"),
      `
        export const nestedSvc = {
          name: "nested-svc",
          dependsOn: [],
          deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
        };
      `,
    );

    const result = await discoverComponents(testDir);

    // first-config/ has no config above it, so it becomes the source root
    // and is scanned; nested-child-project/'s own chant.config.ts is the
    // *second* config encountered, so it is treated as a separate project
    // scope and not descended into.
    expect(result.components.has("first-svc")).toBe(true);
    expect(result.components.has("nested-svc")).toBe(false);
  });

  // ── chant #1108 — build-time parameters populated before import ────────────

  describe("buildParams (chant #1108)", () => {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const paramsPath = resolvePath(thisDir, "../params");

    test("with no buildParams option, params.* stays empty (matches every non-run/generate caller today)", async () => {
      await writeFile(
        join(testDir, "svc.component.ts"),
        `
          export const svc = {
            name: "svc",
            dependsOn: [],
            deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
          };
        `,
      );

      const result = await discoverComponents(testDir);

      expect(result.components.has("svc")).toBe(true);
      expect(params).toEqual({});
    });

    test("populates params.* BEFORE importing *.component.ts, so a live import observes the resolved value", async () => {
      await writeFile(
        join(testDir, "svc.component.ts"),
        `
          import { params } from ${JSON.stringify(paramsPath)};
          export const svc = {
            name: "svc",
            dependsOn: [],
            deploy: [{ phase: "Apply", steps: [{ kind: "shell", command: String(params.tier) }] }],
          };
        `,
      );

      const result = await discoverComponents(testDir, {
        buildParams: [{ name: "tier", value: "production", source: "cli" }],
      });

      expect(result.errors).toEqual([]);
      const svc = result.components.get("svc");
      expect((svc?.component.deploy[0].steps[0] as { command?: unknown }).command).toBe("production");
    });

    test("a second call with no buildParams resets params.* — no stale leak from a prior call in the same process", async () => {
      await writeFile(
        join(testDir, "a.component.ts"),
        `export const a = { name: "a", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }] };`,
      );

      await discoverComponents(testDir, { buildParams: [{ name: "tier", value: "production", source: "cli" }] });
      expect(params).toEqual({ tier: "production" });

      await discoverComponents(testDir);
      expect(params).toEqual({});
    });
  });
});
