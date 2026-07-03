import { describe, expect, it } from "vitest";
import {
  createCfnDeployCapability,
  createEcsUpdateServiceCapability,
  createLambdaDeployCapability,
  CfnReplacementBlockedError,
} from "./apply";
import { createMockCloudExecutor } from "./__tests__/mock-cloud-executor";

const ctx = { env: "dev", component: "orders-table" };

describe("cfn-deploy (#557)", () => {
  it("creates a changeset, executes it, and waits for the stack to reach a terminal status", async () => {
    const mock = createMockCloudExecutor({
      stacks: { "orders-table": { outputs: { TableArn: "arn:aws:dynamodb:table/orders" } } },
    });
    const capability = createCfnDeployCapability(mock.executor);

    const output = await capability.run(ctx, { stack: "orders-table", template: "archive:orders-table.template.json" });

    expect(output.stackStatus).toBe("UPDATE_COMPLETE");
    expect(output.outputs).toEqual({ TableArn: "arn:aws:dynamodb:table/orders" });
    expect(mock.calls.map((c) => c.method)).toEqual(["createChangeSet", "executeChangeSet", "waitForStack"]);
  });

  it("passes wired inputs and imageRef through as CloudFormation parameters", async () => {
    const mock = createMockCloudExecutor({ stacks: { "search-service": {} } });
    const capability = createCfnDeployCapability(mock.executor);

    await capability.run(
      { env: "dev", component: "search-service" },
      {
        stack: "search-service",
        template: "archive:search.template.json",
        imageRef: "sha256:abcdef",
        inputs: { listenerArn: "arn:aws:elb:listener/abc" },
      },
    );

    const createCall = mock.calls.find((c) => c.method === "createChangeSet")!;
    expect(createCall.args).toMatchObject({
      parameters: { listenerArn: "arn:aws:elb:listener/abc", ImageRef: "sha256:abcdef" },
    });
  });

  describe("onReplace safety policy — the data-loss guard the epic requires", () => {
    const replacingChange = {
      action: "Modify" as const,
      logicalResourceId: "OrdersTable",
      resourceType: "AWS::DynamoDB::Table",
      replacement: true,
    };

    it('onReplace: "block" (default) refuses a changeset that would replace a resource', async () => {
      const mock = createMockCloudExecutor({
        stacks: { "orders-table": { changes: [replacingChange] } },
      });
      const capability = createCfnDeployCapability(mock.executor);

      await expect(
        capability.run(ctx, { stack: "orders-table", template: "archive:orders-table.template.json" }),
      ).rejects.toBeInstanceOf(CfnReplacementBlockedError);

      // The changeset must be deleted, never executed — a blocked replacement applies nothing.
      expect(mock.calls.map((c) => c.method)).toEqual(["createChangeSet", "deleteChangeSet"]);
    });

    it('onReplace: "block" is the default when the option is omitted entirely', async () => {
      const mock = createMockCloudExecutor({ stacks: { "orders-table": { changes: [replacingChange] } } });
      const capability = createCfnDeployCapability(mock.executor);
      await expect(
        capability.run(ctx, {
          stack: "orders-table",
          template: "archive:orders-table.template.json",
          // onReplace omitted
        }),
      ).rejects.toBeInstanceOf(CfnReplacementBlockedError);
    });

    it("the blocked error names the specific resources CloudFormation proposed replacing", async () => {
      const mock = createMockCloudExecutor({ stacks: { "orders-table": { changes: [replacingChange] } } });
      const capability = createCfnDeployCapability(mock.executor);
      try {
        await capability.run(ctx, { stack: "orders-table", template: "t.json", onReplace: "block" });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(CfnReplacementBlockedError);
        const blocked = err as CfnReplacementBlockedError;
        expect(blocked.replacements).toEqual([replacingChange]);
        expect(blocked.message).toContain("OrdersTable");
      }
    });

    it('onReplace: "allow" executes the replacing changeset', async () => {
      const mock = createMockCloudExecutor({ stacks: { "orders-table": { changes: [replacingChange] } } });
      const capability = createCfnDeployCapability(mock.executor);
      const output = await capability.run(ctx, {
        stack: "orders-table",
        template: "t.json",
        onReplace: "allow",
      });
      expect(output.stackStatus).toBe("UPDATE_COMPLETE");
      expect(mock.calls.map((c) => c.method)).toEqual(["createChangeSet", "executeChangeSet", "waitForStack"]);
    });

    it('onReplace: "snapshot-first" records a snapshot marker before executing the replacement', async () => {
      const mock = createMockCloudExecutor({ stacks: { "orders-table": { changes: [replacingChange] } } });
      const capability = createCfnDeployCapability(mock.executor);
      const output = await capability.run(ctx, {
        stack: "orders-table",
        template: "t.json",
        onReplace: "snapshot-first",
      });
      expect(output.snapshotId).toBeDefined();
      expect(output.snapshotId).toContain("OrdersTable");
      expect(mock.calls.map((c) => c.method)).toEqual(["createChangeSet", "executeChangeSet", "waitForStack"]);
    });

    it("a non-replacing changeset executes normally under every onReplace policy", async () => {
      for (const onReplace of ["block", "allow", "snapshot-first"] as const) {
        const mock = createMockCloudExecutor({ stacks: { "orders-table": { changes: [] } } });
        const capability = createCfnDeployCapability(mock.executor);
        const output = await capability.run(ctx, { stack: "orders-table", template: "t.json", onReplace });
        expect(output.stackStatus).toBe("UPDATE_COMPLETE");
      }
    });
  });

  it("rollback triggers CloudFormation's native rollback-stack", async () => {
    const mock = createMockCloudExecutor({ stacks: { "orders-table": {} } });
    const capability = createCfnDeployCapability(mock.executor);
    await capability.rollback!(ctx, { stack: "orders-table", template: "t.json" });
    expect(mock.calls).toEqual([{ client: "cloudformation", method: "rollbackStack", args: "orders-table" }]);
  });
});

describe("ecs-update-service (#557)", () => {
  const svcCtx = { env: "dev", component: "search-service" };

  it("updates the service via the executor and returns the deployment id", async () => {
    const mock = createMockCloudExecutor();
    const capability = createEcsUpdateServiceCapability(mock.executor);

    const output = await capability.run(svcCtx, { cluster: "prod", service: "search", imageRef: "sha256:abc" });

    expect(output.deploymentId).toBe("mock-deployment-prod/search");
    const updateCall = mock.calls.find((c) => c.method === "updateService")!;
    expect(updateCall.args).toMatchObject({ cluster: "prod", service: "search", taskDefinition: "sha256:abc" });
  });

  it("declares a capability-level rollback that re-invokes updateService (best-effort)", async () => {
    const mock = createMockCloudExecutor();
    const capability = createEcsUpdateServiceCapability(mock.executor);
    expect(typeof capability.rollback).toBe("function");
    await capability.rollback!(svcCtx, { cluster: "prod", service: "search" });
    expect(mock.calls.map((c) => c.method)).toEqual(["rollbackService"]);
  });
});

describe("lambda-deploy (#558) — the one new capability the fourth validation component needed", () => {
  const lambdaCtx = { env: "dev", component: "image-processor-lambda" };

  it("updates the function's code, waits for the update, publishes a version, and repoints the alias", async () => {
    const mock = createMockCloudExecutor();
    const capability = createLambdaDeployCapability(mock.executor);

    const output = await capability.run(lambdaCtx, {
      functionName: "image-processor",
      codeRef: "123.dkr.ecr.us-east-1.amazonaws.com/image-processor@sha256:abc",
      alias: "live",
    });

    expect(output.version).toBe("1");
    expect(output.functionArn).toContain("image-processor");
    expect(mock.calls.map((c) => c.method)).toEqual([
      "getAliasVersion",
      "updateFunctionCode",
      "waitForUpdate",
      "publishVersion",
      "updateAlias",
    ]);
    const updateCall = mock.calls.find((c) => c.method === "updateFunctionCode")!;
    expect(updateCall.args).toMatchObject({
      functionName: "image-processor",
      imageUri: "123.dkr.ecr.us-east-1.amazonaws.com/image-processor@sha256:abc",
    });
    const aliasCall = mock.calls.find((c) => c.method === "updateAlias")!;
    expect(aliasCall.args).toMatchObject({ functionName: "image-processor", alias: "live", version: "1" });
  });

  it('defaults the alias to "live" when omitted', async () => {
    const mock = createMockCloudExecutor();
    const capability = createLambdaDeployCapability(mock.executor);
    await capability.run(lambdaCtx, { functionName: "image-processor", codeRef: "sha256:abc" });
    const aliasCall = mock.calls.find((c) => c.method === "updateAlias")!;
    expect(aliasCall.args).toMatchObject({ alias: "live" });
  });

  it("skips publish/alias when publish: false, returning $LATEST", async () => {
    const mock = createMockCloudExecutor();
    const capability = createLambdaDeployCapability(mock.executor);
    const output = await capability.run(lambdaCtx, {
      functionName: "image-processor",
      codeRef: "sha256:abc",
      publish: false,
    });
    expect(output.version).toBe("$LATEST");
    expect(mock.calls.some((c) => c.method === "publishVersion")).toBe(false);
    expect(mock.calls.some((c) => c.method === "updateAlias")).toBe(false);
  });

  it("throws when the code update itself fails", async () => {
    const mock = createMockCloudExecutor({ lambdas: { "image-processor": { failUpdate: true } } });
    const capability = createLambdaDeployCapability(mock.executor);
    await expect(
      capability.run(lambdaCtx, { functionName: "image-processor", codeRef: "sha256:abc" }),
    ).rejects.toThrow(/code update ended "Failed"/);
    expect(mock.calls.some((c) => c.method === "publishVersion")).toBe(false);
  });

  it("rollback restores whatever version the alias pointed at before this step ran", async () => {
    const mock = createMockCloudExecutor({ lambdas: { "image-processor": { aliasVersions: { live: "7" } } } });
    const capability = createLambdaDeployCapability(mock.executor);

    await capability.run(lambdaCtx, { functionName: "image-processor", codeRef: "sha256:new", alias: "live" });
    await capability.rollback!(lambdaCtx, { functionName: "image-processor", codeRef: "sha256:new", alias: "live" });

    const aliasCalls = mock.calls.filter((c) => c.method === "updateAlias");
    expect(aliasCalls).toHaveLength(2);
    expect(aliasCalls[1]!.args).toMatchObject({ version: "7" }); // restored to the pre-deploy version.
  });

  it("rollback is a no-op when no prior alias version was recorded (first deploy)", async () => {
    const mock = createMockCloudExecutor();
    const capability = createLambdaDeployCapability(mock.executor);

    await capability.run(lambdaCtx, { functionName: "image-processor", codeRef: "sha256:new", alias: "live" });
    await capability.rollback!(lambdaCtx, { functionName: "image-processor", codeRef: "sha256:new", alias: "live" });

    const aliasCalls = mock.calls.filter((c) => c.method === "updateAlias");
    expect(aliasCalls).toHaveLength(1); // only the run()'s own updateAlias — rollback found nothing to restore.
  });
});
