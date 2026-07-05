import { describe, expect, it } from "vitest";
import { createCodeDeployCapability, createCopyToHostCapability, createRemoteExecCapability } from "./host-delivery";
import { createMockCloudExecutor } from "./__tests__/mock-cloud-executor";

describe("code-deploy (#557 — AWS CodeDeploy)", () => {
  it("creates a deployment and waits for a terminal status", async () => {
    const mock = createMockCloudExecutor();
    const capability = createCodeDeployCapability(mock.executor);

    const output = await capability.run(
      { env: "dev", component: "neo4j-cluster" },
      { application: "neo4j", deploymentGroup: "neo4j-0", revision: { type: "s3", uri: "s3://bucket/neo4j.zip" } },
    );

    expect(output.status).toBe("Succeeded");
    expect(mock.calls.map((c) => c.method)).toEqual(["createDeployment", "waitForDeployment"]);
  });

  it("accepts a bare wired string as the revision (matches the Neo4j pilot's `revision: \"@Seed.templateUri\"`)", async () => {
    const mock = createMockCloudExecutor();
    const capability = createCodeDeployCapability(mock.executor);

    await capability.run(
      { env: "dev", component: "neo4j-cluster" },
      { instance: 1, revision: "s3://bucket/neo4j-seed-uri.zip" },
    );

    const createCall = mock.calls.find((c) => c.method === "createDeployment")!;
    expect(createCall.args).toMatchObject({
      application: "neo4j-cluster",
      deploymentGroup: "neo4j-cluster-1",
      revision: { type: "s3", uri: "s3://bucket/neo4j-seed-uri.zip" },
    });
  });

  it("derives application from ctx.component and deploymentGroup from instance when both are omitted", async () => {
    const mock = createMockCloudExecutor();
    const capability = createCodeDeployCapability(mock.executor);
    await capability.run({ env: "dev", component: "neo4j-cluster" }, { instance: 0, revision: "@Seed.templateUri" });
    const createCall = mock.calls.find((c) => c.method === "createDeployment")!;
    expect(createCall.args).toMatchObject({ application: "neo4j-cluster", deploymentGroup: "neo4j-cluster-0" });
  });

  it("throws when the deployment ends in a non-Succeeded terminal status", async () => {
    const mock = createMockCloudExecutor({ deployments: {} });
    const capability = createCodeDeployCapability(mock.executor);
    // Script the deployment id this run will create to fail.
    const runPromise = capability.run(
      { env: "dev", component: "neo4j-cluster" },
      { instance: 2, revision: "@Seed.templateUri" },
    );
    // The mock assigns deployment ids sequentially; set its status to Failed before awaiting.
    mock.setDeployment("mock-deployment-1", { terminalStatus: "Failed" });
    await expect(runPromise).rejects.toThrow(/ended Failed/);
  });

  it("rollback stops and rolls back the most recent deployment for the same application/deploymentGroup", async () => {
    const mock = createMockCloudExecutor();
    const capability = createCodeDeployCapability(mock.executor);
    const input = { instance: 1, revision: "@Seed.templateUri" };
    await capability.run({ env: "dev", component: "neo4j-cluster" }, input);
    await capability.rollback!({ env: "dev", component: "neo4j-cluster" }, input);
    expect(mock.calls.map((c) => c.method)).toEqual(["createDeployment", "waitForDeployment", "stopAndRollback"]);
  });

  it("rollback is a no-op when this capability instance never deployed to that target", async () => {
    const mock = createMockCloudExecutor();
    const capability = createCodeDeployCapability(mock.executor);
    await capability.rollback!({ env: "dev", component: "neo4j-cluster" }, { instance: 9, revision: "x" });
    expect(mock.calls).toEqual([]);
  });
});

const hostCtx = { env: "dev", component: "svc" };

describe("remote-exec (#557 — SSM Run Command)", () => {
  it("runs the command on the host and returns its stdout + exit code", async () => {
    const mock = createMockCloudExecutor({ hostExecStdout: "hello\n" });
    const out = await createRemoteExecCapability(mock.executor).run(hostCtx, { host: "i-123", command: "echo hello" });
    expect(out).toEqual({ stdout: "hello\n", exitCode: 0 });
    expect(mock.calls).toEqual([{ client: "host", method: "exec", args: { host: "i-123", command: "echo hello", cwd: undefined } }]);
  });

  it("passes cwd through", async () => {
    const mock = createMockCloudExecutor();
    await createRemoteExecCapability(mock.executor).run(hostCtx, { host: "i-1", command: "ls", cwd: "/app" });
    expect(mock.calls[0]!.args).toMatchObject({ cwd: "/app" });
  });

  it("rejects the not-yet-supported ssh transport with a clear message", async () => {
    const mock = createMockCloudExecutor();
    await expect(
      createRemoteExecCapability(mock.executor).run(hostCtx, { host: "h", command: "x", via: "ssh" }),
    ).rejects.toThrow(/ssh transport not yet supported/);
  });

  it("declares no rollback", () => {
    expect(createRemoteExecCapability(createMockCloudExecutor().executor).rollback).toBeUndefined();
  });
});

describe("copy-to-host (#557 — SSM Run Command)", () => {
  it("has the host pull the file from S3 and reports the byte count", async () => {
    const mock = createMockCloudExecutor({ hostExecStdout: "2048\n" });
    const out = await createCopyToHostCapability(mock.executor).run(hostCtx, {
      from: "s3://assets/app.jar",
      host: "i-9",
      to: "/opt/app.jar",
    });
    expect(out).toEqual({ bytesCopied: 2048 });
    const call = mock.calls.find((c) => c.method === "exec")!;
    expect((call.args as { command: string }).command).toContain("aws s3 cp s3://assets/app.jar /opt/app.jar");
    expect((call.args as { command: string }).command).toContain("stat -c %s /opt/app.jar");
  });

  it("reports 0 bytes when the host returns no size", async () => {
    const mock = createMockCloudExecutor({ hostExecStdout: "" });
    const out = await createCopyToHostCapability(mock.executor).run(hostCtx, { from: "s3://b/x", host: "i", to: "/x" });
    expect(out).toEqual({ bytesCopied: 0 });
  });
});
