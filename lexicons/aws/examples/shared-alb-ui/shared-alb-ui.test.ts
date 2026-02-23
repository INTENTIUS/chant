import { describe, test, expect } from "bun:test";
import { lintCommand } from "../../../../packages/core/src/cli/commands/lint";
import { build } from "../../../../packages/core/src/build";
import { resolve } from "path";
import { awsSerializer } from "../../src/serializer";

const srcDir = resolve(import.meta.dir, "src");

describe("shared-alb-ui example", () => {
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

    if (result.errors.length > 0) {
      console.log("Build errors:", result.errors);
    }
    expect(result.errors).toHaveLength(0);

    const template = result.outputs.get("aws");
    expect(template).toBeDefined();

    const parsed = JSON.parse(template!);

    expect(parsed.AWSTemplateFormatVersion).toBe("2010-09-09");
    expect(parsed.Resources).toBeDefined();

    // 7 FargateService resources
    expect(Object.keys(parsed.Resources)).toHaveLength(7);

    expect(parsed.Resources.uiTaskRole).toBeDefined();
    expect(parsed.Resources.uiLogGroup).toBeDefined();
    expect(parsed.Resources.uiTaskDef).toBeDefined();
    expect(parsed.Resources.uiTaskSg).toBeDefined();
    expect(parsed.Resources.uiTargetGroup).toBeDefined();
    expect(parsed.Resources.uiRule).toBeDefined();
    expect(parsed.Resources.uiService).toBeDefined();

    // Parameters for shared ALB refs
    expect(parsed.Parameters).toBeDefined();
    expect(parsed.Parameters.clusterArn).toBeDefined();
    expect(parsed.Parameters.listenerArn).toBeDefined();
  });
});
