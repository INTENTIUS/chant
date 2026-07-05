import { describe, expect, it } from "vitest";
import {
  createWaitForStackCapability,
  createWaitSteadyStateCapability,
  createWaitJobCapability,
} from "./wait-aws";
import { createMockCloudExecutor } from "./__tests__/mock-cloud-executor";

describe("wait-for-stack (#557)", () => {
  it("polls until the stack is terminal and returns the final status", async () => {
    const mock = createMockCloudExecutor({ stacks: { "orders-table": { terminalStatus: "CREATE_COMPLETE" } } });
    const capability = createWaitForStackCapability(mock.executor);
    const output = await capability.run({ env: "dev", component: "orders-table" }, { stack: "orders-table" });
    expect(output.stackStatus).toBe("CREATE_COMPLETE");
  });

  it("declares no rollback — a wait is read-only", () => {
    const capability = createWaitForStackCapability(createMockCloudExecutor().executor);
    expect(capability.rollback).toBeUndefined();
  });
});

describe("wait-steady-state (#557)", () => {
  it("returns runningCount once the ECS service reports stable", async () => {
    const mock = createMockCloudExecutor({
      ecsServices: { "prod/search": { runningCount: 3, desiredCount: 3, stable: true } },
    });
    const capability = createWaitSteadyStateCapability(mock.executor);
    const output = await capability.run(
      { env: "dev", component: "search-service" },
      { service: "search", cluster: "prod" },
    );
    expect(output.runningCount).toBe(3);
  });

  it("defaults the cluster to 'default' when not given (matches the ALB/ECS pilot's bare `{ service }` step)", async () => {
    const mock = createMockCloudExecutor({
      ecsServices: { "default/search": { runningCount: 2, desiredCount: 2, stable: true } },
    });
    const capability = createWaitSteadyStateCapability(mock.executor);
    const output = await capability.run({ env: "dev", component: "search-service" }, { service: "search" });
    expect(output.runningCount).toBe(2);
  });

  it("times out if the service never stabilizes", async () => {
    const mock = createMockCloudExecutor({
      ecsServices: { "prod/search": { runningCount: 1, desiredCount: 3, stable: false } },
    });
    const capability = createWaitSteadyStateCapability(mock.executor);
    await expect(
      capability.run(
        { env: "dev", component: "search-service" },
        { service: "search", cluster: "prod", intervalMs: 1, timeoutMs: 5 },
      ),
    ).rejects.toThrow(/timed out/);
  });
});

describe("wait-job (#561 — EMR job-run poll)", () => {
  it("returns the terminal state once the job run completes", async () => {
    const mock = createMockCloudExecutor({ jobRuns: { "run-1": { terminalState: "COMPLETED" } } });
    const capability = createWaitJobCapability(mock.executor);
    const output = await capability.run({ env: "dev", component: "emr-job" }, { runId: "run-1" });
    expect(output.state).toBe("COMPLETED");
  });

  it("fails when the job run ends in a non-COMPLETED terminal state", async () => {
    const mock = createMockCloudExecutor({ jobRuns: { "run-1": { terminalState: "FAILED" } } });
    const capability = createWaitJobCapability(mock.executor);
    await expect(capability.run({ env: "dev", component: "emr-job" }, { runId: "run-1" })).rejects.toThrow(
      /ended in terminal state "FAILED"/,
    );
  });

  it("declares no rollback — a job-run poll is read-only", () => {
    const capability = createWaitJobCapability(createMockCloudExecutor().executor);
    expect(capability.rollback).toBeUndefined();
  });
});
