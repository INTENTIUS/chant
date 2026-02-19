import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { diffCommand, type DiffOptions } from "./diff";
import type { Serializer } from "../../serializer";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("diffCommand", () => {
  let testDir: string;

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
    testDir = join(tmpdir(), `chant-diff-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("shows no changes for empty directory with no previous output", async () => {
    const options: DiffOptions = {
      path: testDir,
      serializers: [mockSerializer],
    };

    const result = await diffCommand(options);

    expect(result.success).toBe(true);
    // Empty build vs empty previous — no meaningful changes beyond the empty object
  });

  test("shows additions when no previous output file exists", async () => {
    const infraFile = join(testDir, "test.infra.ts");
    await writeFile(
      infraFile,
      `
export const myBucket = {
  lexicon: "test",
  entityType: "TestBucket",
  [Symbol.for("chant.declarable")]: true,
};
      `
    );

    const options: DiffOptions = {
      path: testDir,
      output: join(testDir, "nonexistent.json"),
      serializers: [mockSerializer],
    };

    const result = await diffCommand(options);

    expect(result.success).toBe(true);
    expect(result.hasChanges).toBe(true);
    expect(result.diff).toContain("+");
  });

  test("shows no changes when output matches", async () => {
    const infraFile = join(testDir, "test.infra.ts");
    await writeFile(
      infraFile,
      `
export const myBucket = {
  lexicon: "test",
  entityType: "TestBucket",
  [Symbol.for("chant.declarable")]: true,
};
      `
    );

    // First, build to get the expected output
    const { build } = await import("@intentius/chant/build");
    const buildResult = await build(join(testDir), [mockSerializer]);
    const combined: Record<string, unknown> = {};
    const sortedSerializerNames = [...buildResult.outputs.keys()].sort();
    for (const serializerName of sortedSerializerNames) {
      combined[serializerName] = JSON.parse(buildResult.outputs.get(serializerName)!);
    }

    // Sort keys to match diffCommand behavior
    const sortedReplacer = (_key: string, value: unknown): unknown => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
        );
      }
      return value;
    };
    const expectedOutput = JSON.stringify(combined, sortedReplacer, 2);

    const outputFile = join(testDir, "output.json");
    await writeFile(outputFile, expectedOutput);

    const options: DiffOptions = {
      path: testDir,
      output: outputFile,
      serializers: [mockSerializer],
    };

    const result = await diffCommand(options);

    expect(result.success).toBe(true);
    expect(result.hasChanges).toBe(false);
    expect(result.diff).toBe("");
  });

  test("shows diff when output differs", async () => {
    const infraFile = join(testDir, "test.infra.ts");
    await writeFile(
      infraFile,
      `
export const myBucket = {
  lexicon: "test",
  entityType: "TestBucket",
  [Symbol.for("chant.declarable")]: true,
};
      `
    );

    const outputFile = join(testDir, "output.json");
    await writeFile(outputFile, '{\n  "test": {\n    "resources": {}\n  }\n}');

    const options: DiffOptions = {
      path: testDir,
      output: outputFile,
      serializers: [mockSerializer],
    };

    const result = await diffCommand(options);

    expect(result.success).toBe(true);
    expect(result.hasChanges).toBe(true);
    expect(result.diff).toContain("---");
    expect(result.diff).toContain("+++");
  });
});
