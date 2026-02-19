import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { detectLexicons } from "./detectLexicon";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("detectLexicons", () => {
  let testDir: string;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    testDir = join(tmpdir(), `chant-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up temp directory
    await rm(testDir, { recursive: true, force: true });
  });

  test.each([
    {
      lexicon: "testdom",
      code: 'import * as td from "@intentius/chant-lexicon-testdom";\n\nexport const bucket = new td.storage.Bucket({});',
    },
  ])("detects $lexicon lexicon from import statement", async ({ lexicon, code }) => {
    const file = join(testDir, "infra.ts");
    await writeFile(file, code);

    const result = await detectLexicons([file]);
    expect(result).toEqual([lexicon]);
  });

  test("detects lexicon from destructured import", async () => {
    const file = join(testDir, "infra.ts");
    await writeFile(
      file,
      'import { Bucket, Interpolate } from "@intentius/chant-lexicon-testdom";\n\nexport const bucket = new Bucket({});'
    );

    const result = await detectLexicons([file]);
    expect(result).toEqual(["testdom"]);
  });

  test("detects lexicon across multiple files", async () => {
    const file1 = join(testDir, "storage.ts");
    const file2 = join(testDir, "compute.ts");
    await writeFile(
      file1,
      'import * as td from "@intentius/chant-lexicon-testdom";\n\nexport const bucket = new td.storage.Bucket({});'
    );
    await writeFile(
      file2,
      'import * as td from "@intentius/chant-lexicon-testdom";\n\nexport const fn = new td.compute.Function({});'
    );

    const result = await detectLexicons([file1, file2]);
    expect(result).toEqual(["testdom"]);
  });

  test("throws error when no lexicon is detected", async () => {
    const file = join(testDir, "infra.ts");
    await writeFile(
      file,
      'import { readFile } from "node:fs/promises";\n\nexport const data = {};'
    );

    await expect(detectLexicons([file])).rejects.toThrow(
      "No lexicon detected in infrastructure files"
    );
  });

  test("returns multiple lexicons when multiple files use same lexicon", async () => {
    const file1 = join(testDir, "storage.ts");
    const file2 = join(testDir, "compute.ts");
    await writeFile(
      file1,
      'import * as td from "@intentius/chant-lexicon-testdom";\n\nexport const bucket = new td.storage.Bucket({});'
    );
    await writeFile(
      file2,
      'import * as td from "@intentius/chant-lexicon-testdom";\n\nexport const fn = new td.compute.Function({});'
    );

    const result = await detectLexicons([file1, file2]);
    expect(result).toContain("testdom");
    expect(result).toHaveLength(1);
  });

  test("handles file with no imports gracefully", async () => {
    const file = join(testDir, "empty.ts");
    await writeFile(file, "export const value = 42;");

    await expect(detectLexicons([file])).rejects.toThrow(
      "No lexicon detected in infrastructure files"
    );
  });

  test("handles mixed chant and non-chant imports", async () => {
    const file = join(testDir, "infra.ts");
    await writeFile(
      file,
      'import { readFile } from "node:fs/promises";\nimport * as td from "@intentius/chant-lexicon-testdom";\nimport React from "react";\n\nexport const bucket = new td.storage.Bucket({});'
    );

    const result = await detectLexicons([file]);
    expect(result).toEqual(["testdom"]);
  });

  test("ignores comments containing lexicon names", async () => {
    const file = join(testDir, "infra.ts");
    await writeFile(
      file,
      '// This could be for any lexicon\nimport * as td from "@intentius/chant-lexicon-testdom";\n\nexport const bucket = new td.storage.Bucket({});'
    );

    const result = await detectLexicons([file]);
    expect(result).toEqual(["testdom"]);
  });

  test("handles single-quoted imports", async () => {
    const file = join(testDir, "infra.ts");
    await writeFile(
      file,
      "import * as aws from '@intentius/chant-lexicon-testdom';\n\nexport const bucket = new td.storage.Bucket({});"
    );

    const result = await detectLexicons([file]);
    expect(result).toEqual(["testdom"]);
  });

  test("handles double-quoted imports", async () => {
    const file = join(testDir, "infra.ts");
    await writeFile(
      file,
      'import * as td from "@intentius/chant-lexicon-testdom";\n\nexport const bucket = new td.storage.Bucket({});'
    );

    const result = await detectLexicons([file]);
    expect(result).toEqual(["testdom"]);
  });

  test("handles file that cannot be read", async () => {
    const file = join(testDir, "nonexistent.ts");

    await expect(detectLexicons([file])).rejects.toThrow(
      "No lexicon detected in infrastructure files"
    );
  });

  test("detects lexicon when some files are unreadable", async () => {
    const file1 = join(testDir, "valid.ts");
    const file2 = join(testDir, "nonexistent.ts");
    await writeFile(
      file1,
      'import * as td from "@intentius/chant-lexicon-testdom";\n\nexport const bucket = new td.storage.Bucket({});'
    );

    const result = await detectLexicons([file1, file2]);
    expect(result).toEqual(["testdom"]);
  });

  test("handles multiple imports from same lexicon", async () => {
    const file = join(testDir, "infra.ts");
    await writeFile(
      file,
      'import * as td from "@intentius/chant-lexicon-testdom";\nimport { Bucket } from "@intentius/chant-lexicon-testdom";\nimport type { BucketProps } from "@intentius/chant-lexicon-testdom";\nexport const bucket = new Bucket({});'
    );

    const result = await detectLexicons([file]);
    expect(result).toEqual(["testdom"]);
  });

  test("deduplicates lexicon across multiple files", async () => {
    const file1 = join(testDir, "storage.ts");
    const file2 = join(testDir, "compute.ts");
    const file3 = join(testDir, "networking.ts");
    await writeFile(file1, 'import * as td from "@intentius/chant-lexicon-testdom";');
    await writeFile(file2, 'import * as td from "@intentius/chant-lexicon-testdom";');
    await writeFile(file3, 'import * as td from "@intentius/chant-lexicon-testdom";');

    const result = await detectLexicons([file1, file2, file3]);
    expect(result).toContain("testdom");
    expect(result).toHaveLength(1);
  });

  test("handles empty file array", async () => {
    await expect(detectLexicons([])).rejects.toThrow(
      "No lexicon detected in infrastructure files"
    );
  });

  test("detects lexicon with whitespace variations in import", async () => {
    const file = join(testDir, "infra.ts");
    await writeFile(
      file,
      'import   *   as   td   from   "@intentius/chant-lexicon-testdom"  ;\n\nexport const bucket = new td.storage.Bucket({});'
    );

    const result = await detectLexicons([file]);
    expect(result).toEqual(["testdom"]);
  });

  test("handles import with type modifier", async () => {
    const file = join(testDir, "infra.ts");
    await writeFile(
      file,
      'import type { BucketProps } from "@intentius/chant-lexicon-testdom";\nimport * as td from "@intentius/chant-lexicon-testdom";\nexport const bucket: BucketProps = {};'
    );

    const result = await detectLexicons([file]);
    expect(result).toEqual(["testdom"]);
  });

  test("detects lexicon from export statement", async () => {
    const file = join(testDir, "barrel.ts");
    await writeFile(
      file,
      'export * from "@intentius/chant-lexicon-testdom";\nimport * as core from "@intentius/chant";'
    );

    const result = await detectLexicons([file]);
    expect(result).toEqual(["testdom"]);
  });

  test("detects lexicon from export with curly braces", async () => {
    const file = join(testDir, "barrel.ts");
    await writeFile(
      file,
      'export { Bucket, Interpolate } from "@intentius/chant-lexicon-testdom";'
    );

    const result = await detectLexicons([file]);
    expect(result).toEqual(["testdom"]);
  });
});
