import { describe, expect, it } from "vitest";
import { createEmrStartJobRunCapability, emrSubmitStepCapability as emrSubmitStep } from "./job-submission";
import { createMockCloudExecutor } from "./__tests__/mock-cloud-executor";
import { CapabilityNotImplementedError } from "../capability";

describe("emr-start-job-run (#561)", () => {
  it("starts a job run against the resolved artifact reference and returns the run id", async () => {
    const mock = createMockCloudExecutor();
    const capability = createEmrStartJobRunCapability(mock.executor);

    const output = await capability.run(
      { env: "dev", component: "emr-job" },
      { clusterOrApplicationId: "app-123", jar: "s3://jar-bucket/jar-lib.jar", args: ["--input", "s3://data/in"] },
    );

    expect(output.runId).toBe("mock-job-run-1");
    const call = mock.calls.find((c) => c.client === "emr" && c.method === "startJobRun")!;
    expect(call.args).toMatchObject({
      clusterOrApplicationId: "app-123",
      jar: "s3://jar-bucket/jar-lib.jar",
      args: ["--input", "s3://data/in"],
    });
  });

  it("falls back to ctx.vars.emrApplicationId when clusterOrApplicationId is omitted (matches the emr-job pilot's bare step, which wires the artifact reference but not a literal application id)", async () => {
    const mock = createMockCloudExecutor();
    const capability = createEmrStartJobRunCapability(mock.executor);

    await capability.run(
      { env: "dev", component: "emr-job", vars: { emrApplicationId: "app-from-env" } },
      { jar: "s3://jar-bucket/jar-lib.jar" },
    );

    const call = mock.calls.find((c) => c.client === "emr" && c.method === "startJobRun")!;
    expect(call.args).toMatchObject({ clusterOrApplicationId: "app-from-env" });
  });

  it("falls back to ctx.component as a last resort when neither clusterOrApplicationId nor ctx.vars.emrApplicationId is given", async () => {
    const mock = createMockCloudExecutor();
    const capability = createEmrStartJobRunCapability(mock.executor);

    await capability.run({ env: "dev", component: "emr-job" }, { jar: "s3://jar-bucket/jar-lib.jar" });

    const call = mock.calls.find((c) => c.client === "emr" && c.method === "startJobRun")!;
    expect(call.args).toMatchObject({ clusterOrApplicationId: "emr-job" });
  });

  it("never resolves the @<component>.publish.uri reference itself — it receives whatever the driver already resolved `jar` to", async () => {
    const mock = createMockCloudExecutor();
    const capability = createEmrStartJobRunCapability(mock.executor);

    // Passing the raw reference string through unresolved documents that this
    // capability is not where cross-component wiring happens — ../driver.ts's
    // resolveWiring does that before `run` is ever called.
    await capability.run({ env: "dev", component: "emr-job" }, { jar: "@jar-lib.publish.uri" });

    const call = mock.calls.find((c) => c.client === "emr" && c.method === "startJobRun")!;
    expect(call.args).toMatchObject({ jar: "@jar-lib.publish.uri" });
  });

  it("declares no rollback — starting a job run has nothing to compensate", () => {
    const capability = createEmrStartJobRunCapability(createMockCloudExecutor().executor);
    expect(capability.rollback).toBeUndefined();
  });
});

describe("emr-submit-step (out of #561's scope — remains a typed stub)", () => {
  it("rejects with CapabilityNotImplementedError", async () => {
    await expect(
      emrSubmitStep.run({ env: "dev", component: "emr-job" }, { clusterId: "j-123", name: "step", jar: "s3://x" }),
    ).rejects.toBeInstanceOf(CapabilityNotImplementedError);
  });
});
