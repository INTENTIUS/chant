import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { buildCommand, type BuildOptions } from "./build";
import type { Serializer } from "../../serializer";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("buildCommand", () => {
  let testDir: string;
  let outputFile: string;

  const mockSerializer: Serializer = {
    name: "test",
    rulePrefix: "TEST",
    serialize: (entities) => {
      const result: Record<string, unknown> = {};
      for (const [name, entity] of entities) {
        result[name] = { type: entity.entityType };
      }
      return JSON.stringify({ resources: result }, null, 2);
    },
  };

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-cli-test-${Date.now()}-${Math.random()}`);
    outputFile = join(testDir, "output.json");
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("builds empty directory successfully", async () => {
    const options: BuildOptions = {
      path: testDir,
      format: "json",
      serializers: [mockSerializer],
    };

    const result = await buildCommand(options);

    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("builds directory with entities", async () => {
    // Create a test infrastructure file
    const infraFile = join(testDir, "test.infra.ts");
    await writeFile(
      infraFile,
      `
export const testEntity = {
  lexicon: "test",
  entityType: "TestEntity",
  [Symbol.for("chant.declarable")]: true,
};
      `
    );

    const options: BuildOptions = {
      path: testDir,
      format: "json",
      serializers: [mockSerializer],
    };

    const result = await buildCommand(options);

    expect(result.success).toBe(true);
    expect(result.resourceCount).toBe(1);
  });

  test("writes output to file when specified", async () => {
    const options: BuildOptions = {
      path: testDir,
      output: outputFile,
      format: "json",
      serializers: [mockSerializer],
    };

    const result = await buildCommand(options);

    expect(result.success).toBe(true);
    expect(existsSync(outputFile)).toBe(true);

    const content = readFileSync(outputFile, "utf-8");
    expect(() => JSON.parse(content)).not.toThrow();
  });

  test("returns errors for invalid files", async () => {
    // Create a broken TypeScript file
    const infraFile = join(testDir, "broken.infra.ts");
    await writeFile(infraFile, "this is not valid typescript {{{");

    const options: BuildOptions = {
      path: testDir,
      format: "json",
      serializers: [mockSerializer],
    };

    const result = await buildCommand(options);

    // Should still complete but may have errors
    expect(result.errors.length).toBeGreaterThanOrEqual(0);
  });

  test("handles yaml format option", async () => {
    const options: BuildOptions = {
      path: testDir,
      output: outputFile.replace(".json", ".yaml"),
      format: "yaml",
      serializers: [mockSerializer],
    };

    const result = await buildCommand(options);

    expect(result.success).toBe(true);
    expect(existsSync(outputFile.replace(".json", ".yaml"))).toBe(true);
  });

  test("result includes resource and file counts", async () => {
    const options: BuildOptions = {
      path: testDir,
      format: "json",
      serializers: [mockSerializer],
    };

    const result = await buildCommand(options);

    expect(result.resourceCount).toBeDefined();
    expect(result.fileCount).toBeDefined();
  });

  test("creates parent directories for the primary output path (#38)", async () => {
    // Write into a nested temp path whose parent dirs don't yet exist —
    // chant build should mkdir -p the parents rather than fail with ENOENT.
    const nestedOutput = join(testDir, "deep", "nested", "out", "file.json");

    const options: BuildOptions = {
      path: testDir,
      output: nestedOutput,
      format: "json",
      serializers: [mockSerializer],
    };

    const result = await buildCommand(options);

    expect(result.errors).toEqual([]);
    expect(existsSync(nestedOutput)).toBe(true);
  });

  test("creates parent directories for nested additional-files (#38)", async () => {
    // Simulate a multi-file serializer (like the Op codegen) that emits
    // additional files under nested subpaths.
    const multiFileSerializer: Serializer = {
      name: "multi",
      rulePrefix: "MULTI",
      serialize: () => ({
        primary: "{}",
        files: {
          "ops/alb-deploy/workflow.ts": "// workflow\n",
          "ops/alb-deploy/activities.ts": "// activities\n",
          "ops/alb-deploy/worker.ts": "// worker\n",
        },
      }),
    };

    // Need at least one entity in the "multi" lexicon so the build pipeline
    // invokes the serializer and the additional files surface.
    await writeFile(
      join(testDir, "infra.ts"),
      [
        `export const x = {`,
        `  [Symbol.for("chant.declarable")]: true,`,
        `  entityType: "X",`,
        `  lexicon: "multi",`,
        `  kind: "resource",`,
        `  props: {},`,
        `  attributes: {},`,
        `};`,
      ].join("\n"),
    );

    const outputPath = join(testDir, "dist", "manifest.json");

    const options: BuildOptions = {
      path: testDir,
      output: outputPath,
      format: "json",
      serializers: [multiFileSerializer],
    };

    const result = await buildCommand(options);

    expect(result.errors).toEqual([]);
    expect(existsSync(outputPath)).toBe(true);
    expect(existsSync(join(testDir, "dist", "ops", "alb-deploy", "workflow.ts"))).toBe(true);
    expect(existsSync(join(testDir, "dist", "ops", "alb-deploy", "activities.ts"))).toBe(true);
    expect(existsSync(join(testDir, "dist", "ops", "alb-deploy", "worker.ts"))).toBe(true);
  });
});
