import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { listCommand, type ListOptions } from "./list";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("listCommand", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-list-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("lists empty directory", async () => {
    const options: ListOptions = { path: testDir, format: "text" };
    const result = await listCommand(options);

    expect(result.success).toBe(true);
    expect(result.entities).toHaveLength(0);
    expect(result.output).toContain("No entities found");
  });

  test("lists entities in text format", async () => {
    const infraFile = join(testDir, "test.infra.ts");
    await writeFile(
      infraFile,
      `
export const myBucket = {
  lexicon: "aws",
  entityType: "AWS::S3::Bucket",
  [Symbol.for("chant.declarable")]: true,
};
      `
    );

    const options: ListOptions = { path: testDir, format: "text" };
    const result = await listCommand(options);

    expect(result.success).toBe(true);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe("myBucket");
    expect(result.entities[0].lexicon).toBe("aws");
    expect(result.entities[0].entityType).toBe("AWS::S3::Bucket");
    expect(result.output).toContain("myBucket");
    expect(result.output).toContain("NAME");
  });

  test("lists entities in json format", async () => {
    const infraFile = join(testDir, "test.infra.ts");
    await writeFile(
      infraFile,
      `
export const myFunc = {
  lexicon: "aws",
  entityType: "AWS::Lambda::Function",
  [Symbol.for("chant.declarable")]: true,
};
      `
    );

    const options: ListOptions = { path: testDir, format: "json" };
    const result = await listCommand(options);

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed).toBeArrayOfSize(1);
    expect(parsed[0].name).toBe("myFunc");
  });

  test("entities are sorted by name", async () => {
    const infraFile = join(testDir, "test.infra.ts");
    await writeFile(
      infraFile,
      `
export const zeta = {
  lexicon: "aws",
  entityType: "AWS::S3::Bucket",
  [Symbol.for("chant.declarable")]: true,
};
export const alpha = {
  lexicon: "aws",
  entityType: "AWS::Lambda::Function",
  [Symbol.for("chant.declarable")]: true,
};
      `
    );

    const options: ListOptions = { path: testDir, format: "json" };
    const result = await listCommand(options);

    expect(result.success).toBe(true);
    expect(result.entities[0].name).toBe("alpha");
    expect(result.entities[1].name).toBe("zeta");
  });
});
