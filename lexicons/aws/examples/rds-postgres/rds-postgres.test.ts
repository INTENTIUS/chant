import { describe, test, expect } from "bun:test";
import { lintCommand } from "../../../../packages/core/src/cli/commands/lint";
import { build } from "../../../../packages/core/src/build";
import { resolve } from "path";
import { awsSerializer } from "../../src/serializer";

const srcDir = resolve(import.meta.dir, "src");

describe("rds-postgres example", () => {
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

    // 17 VPC resources + 3 RDS resources (subnetGroup, sg, db) = 20 total
    expect(Object.keys(parsed.Resources)).toHaveLength(20);

    // VPC resources
    expect(parsed.Resources.networkVpc).toBeDefined();
    expect(parsed.Resources.networkNatGateway).toBeDefined();

    // RDS resources
    expect(parsed.Resources.databaseSubnetGroup).toBeDefined();
    expect(parsed.Resources.databaseSg).toBeDefined();
    expect(parsed.Resources.databaseDb).toBeDefined();

    // DB instance properties
    const dbProps = parsed.Resources.databaseDb.Properties;
    expect(dbProps.Engine).toBe("postgres");
    expect(parsed.Resources.databaseDb.Type).toBe("AWS::RDS::DBInstance");
    expect(parsed.Resources.databaseSubnetGroup.Type).toBe("AWS::RDS::DBSubnetGroup");
    expect(parsed.Resources.databaseSg.Type).toBe("AWS::EC2::SecurityGroup");
  });
});
