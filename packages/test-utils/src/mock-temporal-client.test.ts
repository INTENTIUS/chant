import { describe, test, expect } from "vitest";
import { createMockTemporalClient } from "./mock-temporal-client";

describe("createMockTemporalClient", () => {
  test("getHandle().describe() returns the configured description", async () => {
    const mock = createMockTemporalClient({
      describeByWorkflowId: {
        "chant-op-deploy": {
          workflowId: "chant-op-deploy",
          runId: "run-1",
          status: { name: "RUNNING" },
          startTime: new Date("2026-05-01T00:00:00Z"),
          taskQueue: "deploy",
          type: { name: "deployWorkflow" },
        },
      },
    });
    const desc = await mock.client.workflow.getHandle("chant-op-deploy").describe();
    expect(desc.status.name).toBe("RUNNING");
    expect(desc.taskQueue).toBe("deploy");
  });

  test("getHandle().describe() throws for unknown workflow", async () => {
    const mock = createMockTemporalClient();
    await expect(mock.client.workflow.getHandle("missing").describe()).rejects.toThrow(/not found/);
  });

  test("describeError takes precedence over per-workflow descriptions", async () => {
    const mock = createMockTemporalClient({
      describeError: new Error("UNAVAILABLE: cluster offline"),
      describeByWorkflowId: {
        wf: { workflowId: "wf", runId: "r", status: { name: "RUNNING" }, startTime: new Date(), taskQueue: "tq", type: { name: "t" } },
      },
    });
    await expect(mock.client.workflow.getHandle("wf").describe()).rejects.toThrow(/UNAVAILABLE/);
  });

  test("workflow.start records call args and produces a usable handle", async () => {
    const mock = createMockTemporalClient();
    const handle = await mock.client.workflow.start({}, { workflowId: "chant-op-foo", taskQueue: "foo" });
    expect(handle.workflowId).toBe("chant-op-foo");
    expect(mock.calls.startCalls).toHaveLength(1);
    expect(mock.calls.startCalls[0].opts.taskQueue).toBe("foo");
  });

  test("signal and cancel are recorded against the workflow id", async () => {
    const mock = createMockTemporalClient();
    const handle = mock.client.workflow.getHandle("chant-op-foo");
    await handle.signal("gate-dns");
    await handle.cancel();
    expect(mock.calls.signalCalls).toEqual([{ workflowId: "chant-op-foo", signalName: "gate-dns" }]);
    expect(mock.calls.cancelCalls).toEqual([{ workflowId: "chant-op-foo" }]);
  });

  test("workflow.list yields configured summaries", async () => {
    const mock = createMockTemporalClient({
      list: [
        { workflowId: "a", runId: "r1", type: { name: "t" }, status: { name: "COMPLETED" }, startTime: new Date() },
        { workflowId: "b", runId: "r2", type: { name: "t" }, status: { name: "RUNNING" }, startTime: new Date() },
      ],
    });
    const seen: string[] = [];
    for await (const wf of mock.client.workflow.list()) seen.push(wf.workflowId);
    expect(seen).toEqual(["a", "b"]);
  });
});
