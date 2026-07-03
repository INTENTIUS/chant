import { describe, expect, it } from "vitest";
import { createPublishImageCapability } from "./publish";
import { createMockCloudExecutor } from "./__tests__/mock-cloud-executor";

const ctx = { env: "dev", component: "search-service" };

describe("publish-image (#557)", () => {
  it("loads the archived tarball, tags for the destination registry, logs in, and pushes — promoting by digest", async () => {
    const mock = createMockCloudExecutor();
    const capability = createPublishImageCapability(mock.executor);

    const output = await capability.run(ctx, { from: "archive/search.tar", to: "123.dkr.ecr.us-east-1.amazonaws.com/search" });

    expect(output.digest).toMatch(/^sha256:/);
    expect(output.uri).toBe(`123.dkr.ecr.us-east-1.amazonaws.com/search@${output.digest}`);
    expect(mock.calls.map((c) => c.method)).toEqual(["load", "tag", "login", "push"]);
    const loginCall = mock.calls.find((c) => c.method === "login")!;
    expect(loginCall.args).toBe("123.dkr.ecr.us-east-1.amazonaws.com");
  });

  it("pushes additional tags alongside the digest", async () => {
    const mock = createMockCloudExecutor();
    const capability = createPublishImageCapability(mock.executor);

    await capability.run(ctx, {
      from: "archive/search.tar",
      to: "123.dkr.ecr.us-east-1.amazonaws.com/search",
      tags: ["latest", "v1.2.3"],
    });

    const pushCalls = mock.calls.filter((c) => c.method === "push");
    // one push for the digest-qualified reference, one per extra tag
    expect(pushCalls).toHaveLength(3);
    const pushedImages = pushCalls.map((c) => (c.args as { image: string }).image);
    expect(pushedImages.some((i) => i.endsWith(":latest"))).toBe(true);
    expect(pushedImages.some((i) => i.endsWith(":v1.2.3"))).toBe(true);
  });

  it("surfaces a push failure (e.g. registry auth/network) as a rejected promise", async () => {
    const mock = createMockCloudExecutor({ failDocker: true });
    const capability = createPublishImageCapability(mock.executor);
    await expect(
      capability.run(ctx, { from: "archive/search.tar", to: "123.dkr.ecr.us-east-1.amazonaws.com/search" }),
    ).rejects.toThrow(/docker push failed/);
  });

  it("declares no rollback — an already-pushed, content-addressed image is not itself something to undo", () => {
    const capability = createPublishImageCapability(createMockCloudExecutor().executor);
    expect(capability.rollback).toBeUndefined();
  });
});
