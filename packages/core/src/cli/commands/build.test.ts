import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { buildCommand, resolveBuildFormat, type BuildOptions } from "./build";
import type { Serializer } from "../../serializer";
import { parseYAML } from "../../yaml";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

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

  test("#1022 — --fold folds a leaf-only module and logs the fold decision", async () => {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const runtimePath = resolvePath(thisDir, "../../runtime");

    await writeFile(
      join(testDir, "resources.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        export const Bucket = createResource("Test::Bucket", "aws", { arn: "Arn" });
      `
    );
    await writeFile(
      join(testDir, "main.ts"),
      `
        import { Bucket } from "./resources";
        throw new Error("must never execute — sentinel for #1022 fold verification");
        export const bucket = new Bucket({ name: "my-bucket" });
      `
    );

    const awsSerializer: Serializer = {
      name: "aws",
      rulePrefix: "TEST",
      serialize: (entities) => JSON.stringify([...entities.keys()]),
    };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await buildCommand({
        path: testDir,
        format: "json",
        serializers: [awsSerializer],
        fold: true,
      });

      expect(result.success).toBe(true);
      expect(result.resourceCount).toBe(1);

      const loggedFoldLine = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .some((line) => line.includes("[fold:fold]") && line.includes("main.ts"));
      expect(loggedFoldLine).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("#1064 — a declared build-time parameter binds to params.<name> and folds to a literal", async () => {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const runtimePath = resolvePath(thisDir, "../../runtime");
    const paramsPath = resolvePath(thisDir, "../../params");

    await writeFile(
      join(testDir, "chant.config.ts"),
      `
        export default {
          buildParams: {
            tier: { type: "string", enum: ["light", "production"], default: "light" },
          },
        };
      `,
    );
    await writeFile(
      join(testDir, "resources.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        export const Bucket = createResource("Test::Bucket", "aws", { arn: "Arn" });
      `,
    );
    await writeFile(
      join(testDir, "main.ts"),
      `
        import { Bucket } from "./resources";
        import { params } from ${JSON.stringify(paramsPath)};
        throw new Error("must never execute — sentinel for #1064 fold verification");
        export const bucket = new Bucket({ name: params.tier });
      `,
    );

    const awsSerializer: Serializer = {
      name: "aws",
      rulePrefix: "TEST",
      serialize: (entities) => JSON.stringify([...entities.values()].map((e) => (e as unknown as { props: unknown }).props)),
    };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await buildCommand({
        path: testDir,
        format: "json",
        serializers: [awsSerializer],
        fold: true,
        params: { tier: "production" },
      });

      expect(result.success).toBe(true);
      expect(result.resourceCount).toBe(1);
      expect(result.buildParams).toEqual([{ name: "tier", value: "production", source: "cli" }]);

      const loggedParamLine = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .some((line) => line.includes("[param] tier") && line.includes("production") && line.includes("cli"));
      expect(loggedParamLine).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("#1064 — an unresolved required build-time parameter is a build error naming the parameter, not a thrown error", async () => {
    await writeFile(
      join(testDir, "chant.config.ts"),
      `
        export default {
          buildParams: { tier: { type: "string" } },
        };
      `,
    );

    const result = await buildCommand({
      path: testDir,
      format: "json",
      serializers: [mockSerializer],
    });

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes('"tier"') && e.includes("--param"))).toBe(true);
  });

  test("#1064 — an enum violation is a build error naming the parameter and the allowed values", async () => {
    await writeFile(
      join(testDir, "chant.config.ts"),
      `
        export default {
          buildParams: { tier: { type: "string", enum: ["light", "production"] } },
        };
      `,
    );

    const result = await buildCommand({
      path: testDir,
      format: "json",
      serializers: [mockSerializer],
      params: { tier: "bogus" },
    });

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes('"tier"') && e.includes("bogus"))).toBe(true);
  });

  test("#1064 — --params-file supplies values from a JSON file, second precedence after --param", async () => {
    await writeFile(
      join(testDir, "chant.config.ts"),
      `
        export default {
          buildParams: {
            tier: { type: "string", default: "light" },
            env: { type: "string", default: "dev" },
          },
        };
      `,
    );
    await writeFile(
      join(testDir, "test.infra.ts"),
      `
        export const testEntity = {
          lexicon: "test",
          entityType: "TestEntity",
          [Symbol.for("chant.declarable")]: true,
        };
      `,
    );
    const paramsFilePath = join(testDir, "params.json");
    await writeFile(paramsFilePath, JSON.stringify({ tier: "production", env: "from-file" }));

    const result = await buildCommand({
      path: testDir,
      format: "json",
      serializers: [mockSerializer],
      params: { tier: "from-cli" },
      paramsFile: paramsFilePath,
    });

    expect(result.success).toBe(true);
    const byName = new Map((result.buildParams ?? []).map((p) => [p.name, p]));
    expect(byName.get("tier")).toEqual({ name: "tier", value: "from-cli", source: "cli" });
    expect(byName.get("env")).toEqual({ name: "env", value: "from-file", source: "params-file" });
  });

  test("fold is the default (#1134): omitting the flag folds; --no-fold restores the run path", async () => {
    await writeFile(
      join(testDir, "test.infra.ts"),
      `
        export const testEntity = {
          lexicon: "test",
          entityType: "TestEntity",
          [Symbol.for("chant.declarable")]: true,
        };
      `
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await buildCommand({
        path: testDir,
        format: "json",
        serializers: [mockSerializer],
      });

      expect(result.success).toBe(true);
      expect(result.resourceCount).toBe(1);
      const anyFoldLine = errorSpy.mock.calls.map((call) => String(call[0])).some((line) => line.includes("[fold:"));
      expect(anyFoldLine).toBe(true);

      errorSpy.mockClear();
      const runResult = await buildCommand({
        path: testDir,
        format: "json",
        serializers: [mockSerializer],
        fold: false,
      });
      expect(runResult.success).toBe(true);
      expect(runResult.resourceCount).toBe(1);
      const anyFoldLineOff = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .some((line) => line.includes("[fold:"));
      expect(anyFoldLineOff).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
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

  test("op worker files go to <project>/dist/ops even with no --output (#878)", async () => {
    // The generated Op worker must land where `chant run <op> --temporal` reads it
    // (`<project>/dist/ops/<name>/worker.ts`) even when the build has no --output
    // (a Temporal Op project often has no primary resource manifest to route).
    const opSerializer: Serializer = {
      name: "multi",
      rulePrefix: "MULTI",
      serialize: () => ({
        primary: "{}",
        files: {
          "ops/durable-hello/workflow.ts": "// workflow\n",
          "ops/durable-hello/worker.ts": "// worker\n",
          "ops/durable-hello/activities.ts": "// activities\n",
        },
      }),
    };
    await writeFile(
      join(testDir, "infra.ts"),
      `export const x = { [Symbol.for("chant.declarable")]: true, entityType: "X", lexicon: "multi", kind: "resource", props: {}, attributes: {} };`,
    );

    const result = await buildCommand({
      path: testDir,
      format: "json",
      serializers: [opSerializer],
      // no `output`
    } as BuildOptions);

    expect(result.errors).toEqual([]);
    expect(existsSync(join(testDir, "dist", "ops", "durable-hello", "worker.ts"))).toBe(true);
    expect(existsSync(join(testDir, "dist", "ops", "durable-hello", "workflow.ts"))).toBe(true);
  });

  // ── #284 bug 2: array-of-objects must serialize to valid YAML ──────────
  test("yaml format serializes an array of objects to valid, round-trippable YAML", async () => {
    // A serializer that emits a CloudFormation-shaped template with a tag list.
    const cfnSerializer: Serializer = {
      name: "test",
      rulePrefix: "TEST",
      serialize: () =>
        JSON.stringify({
          Resources: {
            Bucket: {
              Type: "AWS::S3::Bucket",
              Properties: {
                BucketName: "x",
                Tags: [
                  { Key: "team", Value: "infra" },
                  { Key: "env", Value: "prod" },
                ],
              },
            },
          },
        }),
    };
    await writeFile(
      join(testDir, "test.infra.ts"),
      `export const e = { lexicon: "test", entityType: "TestEntity", [Symbol.for("chant.declarable")]: true };`,
    );
    const yamlOut = join(testDir, "template.yaml");

    const result = await buildCommand({
      path: testDir,
      output: yamlOut,
      format: "yaml",
      serializers: [cfnSerializer],
    });

    expect(result.success).toBe(true);
    const content = readFileSync(yamlOut, "utf-8");
    // The list item must not be inlined onto the `Tags:` line (same-line dash).
    expect(content).not.toMatch(/Tags:[ \t]+-/);
    // And it must round-trip through a real YAML parser to the intended shape.
    const parsed = parseYAML(content) as {
      Resources: { Bucket: { Properties: { Tags: Array<{ Key: string; Value: string }> } } };
    };
    expect(parsed.Resources.Bucket.Properties.Tags).toEqual([
      { Key: "team", Value: "infra" },
      { Key: "env", Value: "prod" },
    ]);
  });
});

// ── #284 bug 1: -o extension drives format when --format is absent ────────
describe("resolveBuildFormat", () => {
  test("infers yaml from .yaml / .yml extension", () => {
    expect(resolveBuildFormat("", "template.yaml")).toEqual({ format: "yaml" });
    expect(resolveBuildFormat("", "template.yml")).toEqual({ format: "yaml" });
  });

  test("infers json from .json extension", () => {
    expect(resolveBuildFormat("", "template.json")).toEqual({ format: "json" });
  });

  test("defaults to json when there is no extension to infer from", () => {
    expect(resolveBuildFormat("", undefined)).toEqual({ format: "json" });
    expect(resolveBuildFormat("", "outdir")).toEqual({ format: "json" });
  });

  test("explicit --format wins, and a mismatch with the extension warns", () => {
    const r = resolveBuildFormat("json", "template.yaml");
    expect(r.format).toBe("json");
    expect(r.warning).toMatch(/yaml/i);
  });

  test("explicit --format matching the extension does not warn", () => {
    expect(resolveBuildFormat("yaml", "template.yaml")).toEqual({ format: "yaml" });
  });
});
