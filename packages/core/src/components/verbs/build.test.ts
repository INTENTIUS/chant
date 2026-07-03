import { describe, expect, it } from "vitest";
import { createDockerBuildCapability } from "./build";
import { createMockCloudExecutor } from "./__tests__/mock-cloud-executor";

const ctx = { env: "dev", component: "search-service" };

describe("docker-build (#557)", () => {
  it("builds via the injected executor and saves the tarball into the archive path, returning the built digest", async () => {
    const mock = createMockCloudExecutor();
    const capability = createDockerBuildCapability(mock.executor);

    const output = await capability.run(ctx, { context: ".", into: "archive/search.tar" });

    expect(output.archivePath).toBe("archive/search.tar");
    expect(output.digest).toMatch(/^sha256:/);
    expect(mock.calls.map((c) => c.method)).toEqual(["build", "save"]);
    const buildCall = mock.calls.find((c) => c.method === "build")!;
    expect(buildCall.args).toMatchObject({ context: "." });
    const saveCall = mock.calls.find((c) => c.method === "save")!;
    expect(saveCall.args).toMatchObject({ outFile: "archive/search.tar" });
  });

  it("passes dockerfile/target/buildArgs through to the executor", async () => {
    const mock = createMockCloudExecutor();
    const capability = createDockerBuildCapability(mock.executor);

    await capability.run(ctx, {
      context: ".",
      dockerfile: "Dockerfile.prod",
      target: "release",
      buildArgs: { NODE_ENV: "production" },
      into: "archive/x.tar",
    });

    const buildCall = mock.calls.find((c) => c.method === "build")!;
    expect(buildCall.args).toMatchObject({
      dockerfile: "Dockerfile.prod",
      target: "release",
      buildArgs: { NODE_ENV: "production" },
    });
  });

  it("surfaces a docker build failure as a rejected promise (never swallowed)", async () => {
    const mock = createMockCloudExecutor({ failDocker: true });
    const capability = createDockerBuildCapability(mock.executor);
    await expect(capability.run(ctx, { context: ".", into: "archive/x.tar" })).rejects.toThrow(/docker build failed/);
  });

  it("declares no rollback — a local build has no remote/mutable state to compensate", () => {
    const capability = createDockerBuildCapability(createMockCloudExecutor().executor);
    expect(capability.rollback).toBeUndefined();
  });
});
