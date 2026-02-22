import { describe, test, expect } from "bun:test";
import { lintCommand } from "../../../../packages/core/src/cli/commands/lint";
import { build } from "../../../../packages/core/src/build";
import { resolve } from "path";
import { awsSerializer } from "../../src/serializer";

const srcDir = resolve(import.meta.dir, "src");

describe("lambda-api example", () => {
  test("passes strict lint", async () => {
    const result = await lintCommand({
      path: srcDir,
      format: "stylish",
      fix: true,
    });

    if (!result.success || result.errorCount > 0 || result.warningCount > 0) {
      console.log(result.output);
    }

    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  test("build produces valid CloudFormation", async () => {
    const result = await build(srcDir, [awsSerializer]);

    expect(result.errors).toHaveLength(0);

    const template = result.outputs.get("aws");
    expect(template).toBeDefined();

    const parsed = JSON.parse(template!);

    expect(parsed.AWSTemplateFormatVersion).toBe("2010-09-09");
    expect(parsed.Resources).toBeDefined();

    // S3 bucket
    expect(parsed.Resources.dataBucket).toBeDefined();

    // Composite resources expand as {exportName}_{memberName}
    // healthApi
    expect(parsed.Resources.healthApiRole).toBeDefined();
    expect(parsed.Resources.healthApiFunc).toBeDefined();
    expect(parsed.Resources.healthApiPermission).toBeDefined();

    // uploadApi
    expect(parsed.Resources.uploadApiRole).toBeDefined();
    expect(parsed.Resources.uploadApiFunc).toBeDefined();
    expect(parsed.Resources.uploadApiPermission).toBeDefined();

    // processApi
    expect(parsed.Resources.processApiRole).toBeDefined();
    expect(parsed.Resources.processApiFunc).toBeDefined();
    expect(parsed.Resources.processApiPermission).toBeDefined();

    // Total: 1 bucket + 3 composites * 3 resources = 10
    expect(Object.keys(parsed.Resources)).toHaveLength(10);
  });
});
