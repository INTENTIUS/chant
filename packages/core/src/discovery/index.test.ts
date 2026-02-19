import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { discover } from "./index";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DECLARABLE_MARKER } from "../declarable";

describe("discover", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-discover-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("returns empty result for empty directory", async () => {
    const result = await discover(testDir);

    expect(result.entities.size).toBe(0);
    expect(result.dependencies.size).toBe(0);
    expect(result.sourceFiles).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("discovers entities from a single file", async () => {
    await writeFile(
      join(testDir, "app.ts"),
      `
        export const myEntity = {
          entityType: "TestEntity",
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    const result = await discover(testDir);

    expect(result.entities.size).toBe(1);
    expect(result.entities.has("myEntity")).toBe(true);
    expect(result.sourceFiles).toHaveLength(1);
    expect(result.sourceFiles[0]).toMatch(/app\.ts$/);
    expect(result.errors).toEqual([]);
  });

  test("discovers entities from multiple files", async () => {
    await writeFile(
      join(testDir, "app.ts"),
      `
        export const entity1 = {
          entityType: "Entity1",
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    await writeFile(
      join(testDir, "config.ts"),
      `
        export const entity2 = {
          entityType: "Entity2",
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    const result = await discover(testDir);

    expect(result.entities.size).toBe(2);
    expect(result.entities.has("entity1")).toBe(true);
    expect(result.entities.has("entity2")).toBe(true);
    expect(result.sourceFiles).toHaveLength(2);
    expect(result.errors).toEqual([]);
  });

  test("builds dependency graph for entities with references", async () => {
    await writeFile(
      join(testDir, "entities.ts"),
      `
        export const parent = {
          entityType: "Parent",
          [Symbol.for("chant.declarable")]: true,
        };

        export const child = {
          entityType: "Child",
          [Symbol.for("chant.declarable")]: true,
          parentRef: parent,
        };
      `
    );

    const result = await discover(testDir);

    expect(result.entities.size).toBe(2);
    expect(result.dependencies.size).toBe(2);

    const childDeps = result.dependencies.get("child");
    expect(childDeps).toBeDefined();
    expect(childDeps?.has("parent")).toBe(true);

    const parentDeps = result.dependencies.get("parent");
    expect(parentDeps).toBeDefined();
    expect(parentDeps?.size).toBe(0);

    expect(result.errors).toEqual([]);
  });

  test("collects import errors and continues processing", async () => {
    await writeFile(
      join(testDir, "good.ts"),
      `
        export const goodEntity = {
          entityType: "Good",
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    await writeFile(
      join(testDir, "bad.ts"),
      `
        // This will cause a syntax error
        export const badEntity = {
          entityType: "Bad"
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    const result = await discover(testDir);

    // Should still process the good file
    expect(result.entities.has("goodEntity")).toBe(true);
    expect(result.sourceFiles).toHaveLength(2);

    // Should have collected the import error
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e => e.type === "import")).toBe(true);
  });

  test("returns source files even when no entities found", async () => {
    await writeFile(
      join(testDir, "empty.ts"),
      `
        export const notAnEntity = { foo: "bar" };
      `
    );

    const result = await discover(testDir);

    expect(result.entities.size).toBe(0);
    expect(result.sourceFiles).toHaveLength(1);
    expect(result.sourceFiles[0]).toMatch(/empty\.ts$/);
    expect(result.errors).toEqual([]);
  });

  test("handles nested directory structures", async () => {
    const subDir = join(testDir, "src", "entities");
    await mkdir(subDir, { recursive: true });

    await writeFile(
      join(testDir, "root.ts"),
      `
        export const rootEntity = {
          entityType: "Root",
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    await writeFile(
      join(subDir, "nested.ts"),
      `
        export const nestedEntity = {
          entityType: "Nested",
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    const result = await discover(testDir);

    expect(result.entities.size).toBe(2);
    expect(result.entities.has("rootEntity")).toBe(true);
    expect(result.entities.has("nestedEntity")).toBe(true);
    expect(result.sourceFiles).toHaveLength(2);
    expect(result.errors).toEqual([]);
  });

  test("excludes test files from discovery", async () => {
    await writeFile(
      join(testDir, "app.ts"),
      `
        export const appEntity = {
          entityType: "App",
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    await writeFile(
      join(testDir, "app.test.ts"),
      `
        export const testEntity = {
          entityType: "Test",
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    const result = await discover(testDir);

    expect(result.entities.size).toBe(1);
    expect(result.entities.has("appEntity")).toBe(true);
    expect(result.entities.has("testEntity")).toBe(false);
    expect(result.sourceFiles).toHaveLength(1);
  });

  test("filters non-declarable exports", async () => {
    await writeFile(
      join(testDir, "mixed.ts"),
      `
        export const entity = {
          entityType: "Entity",
          [Symbol.for("chant.declarable")]: true,
        };

        export const nonEntity = { foo: "bar" };
        export const anotherNonEntity = 42;
      `
    );

    const result = await discover(testDir);

    expect(result.entities.size).toBe(1);
    expect(result.entities.has("entity")).toBe(true);
    expect(result.entities.has("nonEntity")).toBe(false);
    expect(result.entities.has("anotherNonEntity")).toBe(false);
  });

  test("returns empty dependencies map for entities without references", async () => {
    await writeFile(
      join(testDir, "standalone.ts"),
      `
        export const standalone1 = {
          entityType: "Standalone1",
          [Symbol.for("chant.declarable")]: true,
        };

        export const standalone2 = {
          entityType: "Standalone2",
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    const result = await discover(testDir);

    expect(result.entities.size).toBe(2);
    expect(result.dependencies.size).toBe(2);

    const deps1 = result.dependencies.get("standalone1");
    expect(deps1?.size).toBe(0);

    const deps2 = result.dependencies.get("standalone2");
    expect(deps2?.size).toBe(0);
  });
});
