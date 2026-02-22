import { describe, test, expect } from "bun:test";
import { lintCommand } from "../../../../packages/core/src/cli/commands/lint";
import { build } from "../../../../packages/core/src/build";
import { resolve } from "path";
import { awsSerializer } from "../../src/serializer";

const srcDir = resolve(import.meta.dir, "src");

describe("lambda-patterns example", () => {
  test("lint runs cleanly", async () => {
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

    // Standalone resources
    expect(parsed.Resources.dataTable).toBeDefined();
    expect(parsed.Resources.outputBucket).toBeDefined();
    expect(parsed.Resources.alertTopic).toBeDefined();

    // api (LambdaApi): role + func + permission
    expect(parsed.Resources.api_role).toBeDefined();
    expect(parsed.Resources.api_func).toBeDefined();
    expect(parsed.Resources.api_permission).toBeDefined();

    // worker (NodeLambda): role + func
    expect(parsed.Resources.worker_role).toBeDefined();
    expect(parsed.Resources.worker_func).toBeDefined();

    // cleanup (ScheduledLambda): role + func + rule + permission
    expect(parsed.Resources.cleanup_role).toBeDefined();
    expect(parsed.Resources.cleanup_func).toBeDefined();
    expect(parsed.Resources.cleanup_rule).toBeDefined();
    expect(parsed.Resources.cleanup_permission).toBeDefined();

    // notifier (NodeLambda): role + func
    expect(parsed.Resources.notifier_role).toBeDefined();
    expect(parsed.Resources.notifier_func).toBeDefined();

    // Total: 3 standalone + 3 (api) + 2 (worker) + 4 (cleanup) + 2 (notifier) = 14
    expect(Object.keys(parsed.Resources)).toHaveLength(14);
  });

  test("action constants produce correct IAM actions", async () => {
    const result = await build(srcDir, [awsSerializer]);
    const parsed = JSON.parse(result.outputs.get("aws")!);

    // api role should have DynamoDB ReadWrite actions
    const apiPolicies = parsed.Resources.api_role.Properties.Policies;
    const apiActions = apiPolicies[0].PolicyDocument.Statement[0].Action;
    expect(apiActions).toContain("dynamodb:GetItem");
    expect(apiActions).toContain("dynamodb:PutItem");

    // worker role should have S3 PutObject actions
    const workerPolicies = parsed.Resources.worker_role.Properties.Policies;
    const workerActions = workerPolicies[0].PolicyDocument.Statement[0].Action;
    expect(workerActions).toContain("s3:PutObject");

    // notifier role should have SNS Publish action
    const notifierPolicies = parsed.Resources.notifier_role.Properties.Policies;
    const notifierActions = notifierPolicies[0].PolicyDocument.Statement[0].Action;
    expect(notifierActions).toContain("sns:Publish");
  });

  test("scheduled cleanup has EventBridge rule", async () => {
    const result = await build(srcDir, [awsSerializer]);
    const parsed = JSON.parse(result.outputs.get("aws")!);

    const rule = parsed.Resources.cleanup_rule;
    expect(rule.Type).toBe("AWS::Events::Rule");
    expect(rule.Properties.ScheduleExpression).toBe("rate(1 day)");
    expect(rule.Properties.State).toBe("ENABLED");
  });
});
