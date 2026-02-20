import { describe, test, expect } from "bun:test";
import { lintCommand } from "../../../../packages/core/src/cli/commands/lint";
import { build } from "../../../../packages/core/src/build";
import { resolve } from "path";
import { awsSerializer } from "../../src/serializer";

const srcDir = resolve(import.meta.dir, "src");

describe("getting-started example", () => {
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

    // All 4 resources exist
    expect(parsed.Resources.dataBucket).toBeDefined();
    expect(parsed.Resources.logsBucket).toBeDefined();
    expect(parsed.Resources.functionRole).toBeDefined();
    expect(parsed.Resources.handler).toBeDefined();

    // AttrRef resolution: handler.Role serializes to Fn::GetAtt
    const role = parsed.Resources.handler.Properties.Role;
    expect(role).toBeDefined();
    expect(JSON.stringify(role)).toContain("functionRole");
    expect(JSON.stringify(role)).toContain("Arn");

    // Parameter: environment exists with correct Type/Description/Default
    expect(parsed.Parameters).toBeDefined();
    expect(parsed.Parameters.environment).toBeDefined();
    expect(parsed.Parameters.environment.Type).toBe("String");
    expect(parsed.Parameters.environment.Description).toBe("Deployment environment");
    expect(parsed.Parameters.environment.Default).toBe("dev");

    // Output: dataBucketArn exists
    expect(parsed.Outputs).toBeDefined();
    expect(parsed.Outputs.DataBucketArn).toBeDefined();
    expect(parsed.Outputs.DataBucketArn.Value).toEqual({
      "Fn::GetAttr": ["dataBucket", "Arn"],
    });
  });
});
