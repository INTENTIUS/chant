import { describe, expect, it } from "vitest";
import {
  createWaitForStackCapability,
  createWaitSteadyStateCapability,
  createWaitClusterHealthyCapability,
  createWaitJobCapability,
  createWaitEndpointCapability,
  createHealthGateCapability,
} from "./wait-verify";
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

describe("wait-cluster-healthy (#557 — Neo4j bolt/quorum probe)", () => {
  it("size mode: resolves once the exact required member count is healthy", async () => {
    const mock = createMockCloudExecutor({ clusters: { "host1:7687": { healthyCount: 1 } } });
    const capability = createWaitClusterHealthyCapability(mock.executor);
    const output = await capability.run(
      { env: "dev", component: "neo4j-cluster" },
      { cluster: "host1:7687", size: 1 },
    );
    expect(output.healthyCount).toBe(1);
  });

  it("quorum mode: resolves once a majority of the cluster list is healthy", async () => {
    const mock = createMockCloudExecutor({
      clusters: { "host1:7687,host2:7687,host3:7687": { healthyCount: 2 } },
    });
    const capability = createWaitClusterHealthyCapability(mock.executor);
    const output = await capability.run(
      { env: "dev", component: "neo4j-cluster" },
      { cluster: "host1:7687,host2:7687,host3:7687", quorum: true },
    );
    expect(output.healthyCount).toBe(2);
  });

  it("quorum mode: does not resolve until a majority (not just >0) is healthy", async () => {
    const mock = createMockCloudExecutor({
      clusters: { "host1:7687,host2:7687,host3:7687": { healthyCount: 1 } },
    });
    const capability = createWaitClusterHealthyCapability(mock.executor);
    await expect(
      capability.run(
        { env: "dev", component: "neo4j-cluster" },
        { cluster: "host1:7687,host2:7687,host3:7687", quorum: true, intervalMs: 1, timeoutMs: 5 },
      ),
    ).rejects.toThrow(/timed out/);
  });

  it("falls back to ctx.vars.clusterEndpoints when `cluster` is omitted (matches the Neo4j pilot's bare steps)", async () => {
    const mock = createMockCloudExecutor({ clusters: { "az0:7687": { healthyCount: 1 } } });
    const capability = createWaitClusterHealthyCapability(mock.executor);
    const output = await capability.run(
      { env: "dev", component: "neo4j-cluster", vars: { clusterEndpoints: "az0:7687" } },
      { size: 1 },
    );
    expect(output.healthyCount).toBe(1);
  });

  it("declares no rollback — a health probe is read-only", () => {
    const capability = createWaitClusterHealthyCapability(createMockCloudExecutor().executor);
    expect(capability.rollback).toBeUndefined();
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

const httpCtx = { env: "dev", component: "svc" };

describe("wait-endpoint (#557)", () => {
  it("returns the status once the endpoint matches an expected code", async () => {
    let n = 0;
    const cap = createWaitEndpointCapability(async () => (++n < 2 ? { status: 503, ok: false } : { status: 200, ok: true }));
    const out = await cap.run(httpCtx, { url: "http://x/health", intervalMs: 0 });
    expect(out.status).toBe(200);
    expect(n).toBe(2); // retried once before success
  });

  it("keeps polling when fetch throws (endpoint not up yet)", async () => {
    let n = 0;
    const cap = createWaitEndpointCapability(async () => {
      if (++n < 2) throw new Error("ECONNREFUSED");
      return { status: 200, ok: true };
    });
    const out = await cap.run(httpCtx, { url: "http://x", intervalMs: 0 });
    expect(out.status).toBe(200);
  });

  it("times out when the endpoint never matches", async () => {
    const cap = createWaitEndpointCapability(async () => ({ status: 500, ok: false }));
    await expect(cap.run(httpCtx, { url: "http://x", intervalMs: 0, timeoutMs: 0 })).rejects.toThrow("wait-endpoint");
  });

  it("declares no rollback — a wait is read-only", () => {
    expect(createWaitEndpointCapability().rollback).toBeUndefined();
  });
});

describe("health-gate (#557)", () => {
  it("passes only after the required consecutive successes (a failure resets the streak)", async () => {
    const results = [true, false, true, true];
    let i = 0;
    const cap = createHealthGateCapability(async () => ({ status: 200, ok: results[i++] ?? true }));
    const out = await cap.run(httpCtx, { path: "http://x/healthz", consecutiveSuccesses: 2, intervalMs: 0 });
    expect(out.healthy).toBe(true);
    expect(i).toBe(4); // ok, fail(reset), ok, ok -> two in a row
  });

  it("treats a thrown fetch as unhealthy", async () => {
    let i = 0;
    const cap = createHealthGateCapability(async () => {
      if (++i < 2) throw new Error("down");
      return { status: 200, ok: true };
    });
    const out = await cap.run(httpCtx, { path: "http://x", intervalMs: 0 });
    expect(out.healthy).toBe(true);
  });
});
