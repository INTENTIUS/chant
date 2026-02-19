import { describe, test, expect } from "bun:test";
import { lintCommand } from "../../../../packages/core/src/cli/commands/lint";
import { build } from "../../../../packages/core/src/build";
import { resolve } from "path";
import { awsSerializer } from "../../src/serializer";

const srcDir = resolve(import.meta.dir, "src");

describe("advanced example", () => {
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
    expect(parsed.Resources.healthApi_role).toBeDefined();
    expect(parsed.Resources.healthApi_func).toBeDefined();
    expect(parsed.Resources.healthApi_permission).toBeDefined();

    // uploadApi
    expect(parsed.Resources.uploadApi_role).toBeDefined();
    expect(parsed.Resources.uploadApi_func).toBeDefined();
    expect(parsed.Resources.uploadApi_permission).toBeDefined();

    // processApi
    expect(parsed.Resources.processApi_role).toBeDefined();
    expect(parsed.Resources.processApi_func).toBeDefined();
    expect(parsed.Resources.processApi_permission).toBeDefined();

    // Total: 1 bucket + 3 composites * 3 resources = 10
    expect(Object.keys(parsed.Resources)).toHaveLength(10);
  });
});
