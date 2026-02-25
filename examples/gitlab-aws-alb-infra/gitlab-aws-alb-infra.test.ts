import { describe, test, expect } from "bun:test";
import { lintCommand } from "../../packages/core/src/cli/commands/lint";
import { build } from "../../packages/core/src/build";
import { resolve } from "path";
import { awsSerializer } from "../../lexicons/aws/src/serializer";
import { gitlabSerializer } from "../../lexicons/gitlab/src/serializer";

const srcDir = resolve(import.meta.dir, "src");

describe("gitlab-aws-alb-infra example", () => {
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

  test("build produces valid CloudFormation template", async () => {
    const result = await build(srcDir, [awsSerializer, gitlabSerializer]);

    if (result.errors.length > 0) {
      console.log("Build errors:", result.errors);
    }
    expect(result.errors).toHaveLength(0);

    const template = result.outputs.get("aws");
    expect(template).toBeDefined();

    const parsed = JSON.parse(template!);

    expect(parsed.AWSTemplateFormatVersion).toBe("2010-09-09");
    expect(parsed.Resources).toBeDefined();

    // 17 VPC resources + 5 AlbShared + 2 ECR repos = 24 total
    expect(Object.keys(parsed.Resources)).toHaveLength(24);

    // VPC resources
    expect(parsed.Resources.networkVpc).toBeDefined();

    // AlbShared resources
    expect(parsed.Resources.sharedCluster).toBeDefined();
    expect(parsed.Resources.sharedAlb).toBeDefined();
    expect(parsed.Resources.sharedListener).toBeDefined();
    expect(parsed.Resources.sharedAlbSg).toBeDefined();
    expect(parsed.Resources.sharedExecutionRole).toBeDefined();

    // Outputs
    expect(parsed.Outputs).toBeDefined();
    expect(parsed.Outputs.ClusterArn).toBeDefined();
    expect(parsed.Outputs.ListenerArn).toBeDefined();
    expect(parsed.Outputs.AlbSgId).toBeDefined();
    expect(parsed.Outputs.ExecutionRoleArn).toBeDefined();
    expect(parsed.Outputs.AlbDnsName).toBeDefined();
    expect(parsed.Outputs.VpcId).toBeDefined();
    expect(parsed.Outputs.PrivateSubnet1).toBeDefined();
    expect(parsed.Outputs.PrivateSubnet2).toBeDefined();
    expect(parsed.Outputs.ApiRepoUri).toBeDefined();
    expect(parsed.Outputs.UiRepoUri).toBeDefined();
  });

  test("build produces valid GitLab CI YAML", async () => {
    const result = await build(srcDir, [awsSerializer, gitlabSerializer]);

    expect(result.errors).toHaveLength(0);

    const output = result.outputs.get("gitlab");
    expect(output).toBeDefined();

    expect(output).toContain("stages:");
    expect(output).toContain("deploy");
    expect(output).toContain("cloudformation");
  });
});
