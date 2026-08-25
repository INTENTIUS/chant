/**
 * Tests `wrangler-deploy`/`wrangler-versions-promote` (#1293, epic #1296,
 * ./wrangler.ts) against a `MockProcessRunner` — no live `wrangler`, no
 * network call, ever. Asserts the constructed invocations, the version-id
 * extraction, the wired output -> promote input handoff, and the
 * captured-previous-version rollback (the "no hand-written compensation"
 * claim from #1293's verification section).
 */

import { describe, expect, it } from "vitest";
import {
  createWranglerDeployCapability,
  createWranglerVersionsPromoteCapability,
  parseWranglerVersionId,
  WranglerVersionIdNotFoundError,
} from "./wrangler";
import { ToolNotAvailableError } from "./process-runner";
import { createMockProcessRunner } from "./__tests__/mock-process-runner";

const ctx = { env: "prod", component: "api-worker" };
const VERSION_A = "07bcb198-9633-4172-a1f0-b09f6f1a1a11";
const VERSION_B = "aa11bb22-cc33-dd44-ee55-ff6677889900";

describe("wrangler-deploy", () => {
  it("shells `wrangler deploy` with --config, extracts the Version ID from stdout", async () => {
    const mock = createMockProcessRunner({
      responses: { "wrangler deploy": `Uploaded api-worker (1.23 sec)\nVersion ID: ${VERSION_A}\n` },
    });
    const capability = createWranglerDeployCapability(mock.runner);

    const output = await capability.run(ctx, { config: "api/wrangler.jsonc" });

    expect(output).toEqual({ versionId: VERSION_A });
    const deployCall = mock.calls.find((c) => c.command.startsWith("wrangler deploy"))!;
    expect(deployCall.command).toBe(`wrangler deploy --config 'api/wrangler.jsonc'`);
  });

  it("passes --env through when supplied", async () => {
    const mock = createMockProcessRunner({
      responses: { "wrangler deploy": `Version ID: ${VERSION_A}\n` },
    });
    const capability = createWranglerDeployCapability(mock.runner);

    await capability.run(ctx, { config: "api/wrangler.jsonc", env: "staging" });

    const deployCall = mock.calls.find((c) => c.command.startsWith("wrangler deploy"))!;
    expect(deployCall.command).toBe(`wrangler deploy --config 'api/wrangler.jsonc' --env 'staging'`);
  });

  it("throws WranglerVersionIdNotFoundError when stdout carries no Version ID", async () => {
    const mock = createMockProcessRunner({ responses: { "wrangler deploy": "Uploaded, nothing else.\n" } });
    const capability = createWranglerDeployCapability(mock.runner);

    await expect(capability.run(ctx, { config: "api/wrangler.jsonc" })).rejects.toBeInstanceOf(
      WranglerVersionIdNotFoundError,
    );
  });

  it("throws ToolNotAvailableError when wrangler is absent, rather than silently no-op'ing", async () => {
    const mock = createMockProcessRunner({ tools: { wrangler: false } });
    const capability = createWranglerDeployCapability(mock.runner);

    await expect(capability.run(ctx, { config: "api/wrangler.jsonc" })).rejects.toBeInstanceOf(
      ToolNotAvailableError,
    );
  });

  it("declares a rollback (native rollback disposition, no rollbackPolicy override needed)", () => {
    const capability = createWranglerDeployCapability(createMockProcessRunner().runner);
    expect(typeof capability.rollback).toBe("function");
    expect(capability.rollbackPolicy).toBeUndefined();
  });

  it("rollback is a no-op on a first deploy — nothing was live before it", async () => {
    const mock = createMockProcessRunner({
      responses: { "versions list": "[]", "wrangler deploy": `Version ID: ${VERSION_A}\n` },
    });
    const capability = createWranglerDeployCapability(mock.runner);
    await capability.run(ctx, { config: "api/wrangler.jsonc" });

    await capability.rollback!(ctx, { config: "api/wrangler.jsonc" });

    expect(mock.calls.some((c) => c.command.includes("versions deploy"))).toBe(false);
  });

  it("rollback promotes back to whichever version was live before this deploy — the wrangler-versions-promote back-to-prior-version claim, with no hand-written compensation", async () => {
    const mock = createMockProcessRunner({
      responses: {
        "versions list": JSON.stringify([{ id: VERSION_A, percentage: 100 }]),
        "wrangler deploy": `Version ID: ${VERSION_B}\n`,
      },
    });
    const capability = createWranglerDeployCapability(mock.runner);
    await capability.run(ctx, { config: "api/wrangler.jsonc" });

    await capability.rollback!(ctx, { config: "api/wrangler.jsonc" });

    const promoteCall = mock.calls.find((c) => c.command.startsWith("wrangler versions deploy"))!;
    expect(promoteCall.command).toBe(
      `wrangler versions deploy '${VERSION_A}@100' --config 'api/wrangler.jsonc' --yes`,
    );
  });
});

describe("wrangler-versions-promote", () => {
  it("shells `wrangler versions deploy <id>@<pct> --yes`, defaulting percentage to 100", async () => {
    const mock = createMockProcessRunner();
    const capability = createWranglerVersionsPromoteCapability(mock.runner);

    const output = await capability.run(ctx, { config: "api/wrangler.jsonc", versionId: VERSION_A });

    expect(output).toEqual({ versionId: VERSION_A, percentage: 100 });
    const promoteCall = mock.calls.find((c) => c.command.startsWith("wrangler versions deploy"))!;
    expect(promoteCall.command).toBe(
      `wrangler versions deploy '${VERSION_A}@100' --config 'api/wrangler.jsonc' --yes`,
    );
  });

  it("consumes a wired wrangler-deploy output as its versionId input", async () => {
    const mock = createMockProcessRunner({
      responses: { "wrangler deploy": `Version ID: ${VERSION_A}\n` },
    });
    const deploy = createWranglerDeployCapability(mock.runner);
    const promote = createWranglerVersionsPromoteCapability(mock.runner);

    const { versionId } = await deploy.run(ctx, { config: "api/wrangler.jsonc" });
    const promoted = await promote.run(ctx, { config: "api/wrangler.jsonc", versionId, percentage: 10 });

    expect(promoted).toEqual({ versionId: VERSION_A, percentage: 10 });
    const promoteCall = mock.calls.find((c) => c.command.startsWith("wrangler versions deploy"))!;
    expect(promoteCall.command).toContain(`'${VERSION_A}@10'`);
  });

  it("declares a rollback (native): re-promotes to whichever version was live before this promote call", async () => {
    const mock = createMockProcessRunner({
      responses: { "versions list": JSON.stringify([{ id: VERSION_A, percentage: 100 }]) },
    });
    const capability = createWranglerVersionsPromoteCapability(mock.runner);
    await capability.run(ctx, { config: "api/wrangler.jsonc", versionId: VERSION_B });

    await capability.rollback!(ctx, { config: "api/wrangler.jsonc", versionId: VERSION_B });

    const calls = mock.calls.filter((c) => c.command.startsWith("wrangler versions deploy"));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.command).toContain(`'${VERSION_B}@100'`);
    expect(calls[1]!.command).toContain(`'${VERSION_A}@100'`);
  });

  it("throws ToolNotAvailableError when wrangler is absent", async () => {
    const mock = createMockProcessRunner({ tools: { wrangler: false } });
    const capability = createWranglerVersionsPromoteCapability(mock.runner);

    await expect(
      capability.run(ctx, { config: "api/wrangler.jsonc", versionId: VERSION_A }),
    ).rejects.toBeInstanceOf(ToolNotAvailableError);
  });
});

describe("parseWranglerVersionId", () => {
  it("accepts both 'Version ID:' and bare 'Version:' wording", () => {
    expect(parseWranglerVersionId(`Version ID: ${VERSION_A}`)).toBe(VERSION_A);
    expect(parseWranglerVersionId(`Version: ${VERSION_A}`)).toBe(VERSION_A);
  });

  it("throws on stdout with no UUID-shaped version token", () => {
    expect(() => parseWranglerVersionId("Version: 2 (a plain counter, not a version id)")).toThrow(
      WranglerVersionIdNotFoundError,
    );
  });
});
