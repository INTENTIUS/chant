import { describe, test, expect } from "vitest";
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { awsSerializer } from "@intentius/chant-lexicon-aws";
import { resolve } from "path";
import { readdirSync } from "fs";

/** Helper: parse CFN JSON and assert resource existence + count */
function cfnChecks(
  expectations: {
    resources?: string[];
    resourceCount?: number;
    outputs?: string[];
    parameters?: string[];
  },
) {
  return (output: string) => {
    const parsed = JSON.parse(output);
    expect(parsed.AWSTemplateFormatVersion).toBe("2010-09-09");
    expect(parsed.Resources).toBeDefined();

    if (expectations.resources) {
      for (const r of expectations.resources) {
        expect(parsed.Resources[r]).toBeDefined();
      }
    }
    if (expectations.resourceCount !== undefined) {
      expect(Object.keys(parsed.Resources)).toHaveLength(
        expectations.resourceCount,
      );
    }
    if (expectations.outputs) {
      expect(parsed.Outputs).toBeDefined();
      for (const o of expectations.outputs) {
        expect(parsed.Outputs[o]).toBeDefined();
      }
    }
    if (expectations.parameters) {
      expect(parsed.Parameters).toBeDefined();
      for (const p of expectations.parameters) {
        expect(parsed.Parameters[p]).toBeDefined();
      }
    }
  };
}

const config = {
  lexicon: "aws",
  serializer: awsSerializer,
  outputKey: "aws",
  examplesDir: import.meta.dirname,
};

describeAllExamples(config, {
  "lambda-function": {
    checks: cfnChecks({
      resources: ["appRole", "appFunc"],
      resourceCount: 2,
    }),
  },
  "lambda-api": {
    checks: cfnChecks({
      resources: [
        "dataBucket",
        "healthApiRole",
        "healthApiFunc",
        "healthApiPermission",
        "uploadApiRole",
        "uploadApiFunc",
        "uploadApiPermission",
        "processApiRole",
        "processApiFunc",
        "processApiPermission",
      ],
      resourceCount: 10,
    }),
  },
  "lambda-s3": {
    checks: cfnChecks({
      resources: ["appBucket", "appRole", "appFunc"],
    }),
  },
  "lambda-dynamodb": {
    checks: cfnChecks({
      resources: ["appTable", "appRole", "appFunc"],
    }),
  },
  "lambda-sqs": {
    checks: cfnChecks({
      resources: ["appQueue", "appRole", "appFunc"],
    }),
  },
  "lambda-sns": {
    checks: cfnChecks({
      resources: [
        "appTopic",
        "appRole",
        "appFunc",
        "appSubscription",
        "appPermission",
      ],
    }),
  },
  "lambda-scheduled": {
    checks: cfnChecks({
      resources: ["appRole", "appFunc", "appRule", "appPermission"],
    }),
  },
  "lambda-eventbridge": {
    checks: cfnChecks({
      resources: ["appRule", "appRole", "appFunc", "appPermission"],
    }),
  },
  "vpc": {
    checks: cfnChecks({
      resources: ["networkVpc", "networkIgw", "networkNatGateway"],
      resourceCount: 17,
    }),
  },
  "fargate-alb": {
    checks: cfnChecks({
      resources: ["networkVpc", "networkIgw", "webCluster", "webAlb", "webService"],
      resourceCount: 28,
    }),
  },
  "multi-service-alb": {
    checks: cfnChecks({ resourceCount: 36 }),
  },
  "shared-alb": {
    checks: cfnChecks({
      resources: [
        "networkVpc",
        "sharedCluster",
        "sharedAlb",
        "sharedListener",
        "sharedAlbSg",
        "sharedExecutionRole",
      ],
      resourceCount: 24,
      outputs: [
        "ClusterArn",
        "ListenerArn",
        "AlbSgId",
        "ExecutionRoleArn",
        "AlbDnsName",
        "VpcId",
        "PrivateSubnet1",
        "PrivateSubnet2",
        "ApiRepoUri",
        "UiRepoUri",
      ],
    }),
  },
  "shared-alb-api": {
    checks: cfnChecks({
      resources: [
        "apiTaskRole",
        "apiLogGroup",
        "apiTaskDef",
        "apiTaskSg",
        "apiTargetGroup",
        "apiRule",
        "apiService",
      ],
      resourceCount: 7,
      parameters: [
        "clusterArn",
        "listenerArn",
        "albSgId",
        "executionRoleArn",
        "vpcId",
        "privateSubnet1",
        "privateSubnet2",
        "image",
      ],
    }),
  },
  "shared-alb-ui": {
    checks: cfnChecks({
      resources: [
        "uiTaskRole",
        "uiLogGroup",
        "uiTaskDef",
        "uiTaskSg",
        "uiTargetGroup",
        "uiRule",
        "uiService",
      ],
      resourceCount: 7,
      parameters: [
        "clusterArn",
        "listenerArn",
        "albSgId",
        "executionRoleArn",
        "vpcId",
        "privateSubnet1",
        "privateSubnet2",
        "image",
      ],
    }),
  },
  "rds-postgres": {
    checks: (output) => {
      const parsed = JSON.parse(output);
      expect(parsed.AWSTemplateFormatVersion).toBe("2010-09-09");
      expect(Object.keys(parsed.Resources)).toHaveLength(20);
      expect(parsed.Resources.databaseSubnetGroup).toBeDefined();
      expect(parsed.Resources.databaseSg).toBeDefined();
      expect(parsed.Resources.databaseDb).toBeDefined();
      const db = parsed.Resources.databaseDb;
      expect(db.Type).toBe("AWS::RDS::DBInstance");
      expect(db.Properties.Engine).toBe("postgres");
    },
  },
  "core-concepts": { skipLint: true, skipBuild: true },
  "docs-snippets": { skipLint: true, skipBuild: true },
});

// core-concepts: relaxed lint + file import validation
describe("aws core-concepts example", () => {
  const srcDir = resolve(import.meta.dirname, "core-concepts", "src");

  test("lint runs without crashing", async () => {
    const result = await lintCommand({
      path: srcDir,
      format: "stylish",
      fix: true,
    });
    expect(result.output).toBeDefined();
  });

  test("all source files can be imported", async () => {
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && f !== "_.ts");
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(() => require(resolve(srcDir, file))).not.toThrow();
    }
  }, 30_000);
});

// docs-snippets: relaxed lint + file import validation
describe("aws docs-snippets example", () => {
  const srcDir = resolve(import.meta.dirname, "docs-snippets", "src");

  test("lint runs without crashing", async () => {
    const result = await lintCommand({
      path: srcDir,
      format: "stylish",
      fix: true,
    });
    expect(result.output).toBeDefined();
  });

  test("all snippet files can be imported", async () => {
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && f !== "_.ts");
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(() => require(resolve(srcDir, file))).not.toThrow();
    }
  });
});
