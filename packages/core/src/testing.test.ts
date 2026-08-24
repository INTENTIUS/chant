import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockPlugin } from "@intentius/chant-test-utils";
import { deployStack, testEnvName, TeardownIncompleteError } from "./testing";
import type { ActivityFn } from "./op/activity-registry";
import type { TeardownExecution } from "./lexicon";

/** A minimal deployable project: one declarable, mock lexicon, marker on. */
async function writeProject(
  dir: string,
  config: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "chant.config.json"),
    JSON.stringify({
      lexicons: ["mock"],
      ownership: { stack: "harness-fixture" },
      environments: ["dev", { name: "test-*", endpoint: "http://localhost:9999" }],
      ...config,
    }),
  );
  await writeFile(
    join(dir, "app.infra.ts"),
    `export const bucket = {
  lexicon: "mock",
  entityType: "Mock::Bucket",
  [Symbol.for("chant.declarable")]: true,
};
`,
  );
}

describe("testEnvName", () => {
  test("prefixes test-, slugs the suite, appends a nonce", () => {
    const name = testEnvName("My Fancy Suite!");
    expect(name).toMatch(/^test-my-fancy-suite-[a-z0-9]{6}$/);
  });

  test("two calls never collide", () => {
    expect(testEnvName("s")).not.toBe(testEnvName("s"));
  });

  test("an all-symbol suite still produces a legal name", () => {
    expect(testEnvName("!!!")).toMatch(/^test-suite-[a-z0-9]{6}$/);
  });
});

describe("deployStack", () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `chant-testing-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const harness = (nativeApply: ActivityFn, overrides: Record<string, unknown> = {}) => ({
    dir,
    suite: "unit",
    plugins: [createMockPlugin({ name: "mock" })],
    activities: new Map([["nativeApply", nativeApply]]),
    profiles: {},
    applyTargets: { mock: "cloudformation" },
    ...overrides,
  });

  test("deploy returns outputs, entities, and a nonce'd test env", async () => {
    await writeProject(dir);
    const nativeApply = vi.fn(async (_args: Record<string, unknown>) => ({ applied: 1, pruned: 0, notAttempted: 0 }));

    const stack = await deployStack(harness(nativeApply));

    expect(stack.env).toMatch(/^test-unit-[a-z0-9]{6}$/);
    expect(stack.entities.has("bucket")).toBe(true);
    const output = stack.outputs.get("mock");
    expect(output).toBeDefined();
    const primary = typeof output === "string" ? output : output!.primary;
    expect(JSON.parse(primary).resources.bucket).toEqual({ type: "Mock::Bucket" });

    // The apply was additive, targeted at this env, over the written output.
    expect(nativeApply).toHaveBeenCalledTimes(1);
    const args = nativeApply.mock.calls[0][0] as Record<string, unknown>;
    expect(args.target).toBe("cloudformation");
    expect(args.env).toBe(stack.env);
    expect(args.deleteMode).toBe("never");
    expect(JSON.parse(readFileSync(args.output as string, "utf-8")).resources.bucket).toBeDefined();
  });

  test("the declared test-* endpoint is applied during the deploy", async () => {
    await writeProject(dir);
    let seenDuringApply: string | undefined;
    const nativeApply = vi.fn(async (_args: Record<string, unknown>) => {
      seenDuringApply = process.env.MOCK_ENDPOINT_URL;
      return { applied: 1, pruned: 0, notAttempted: 0 };
    });
    const plugin = createMockPlugin({
      name: "mock",
      emulator: {
        spec: { name: "chant-mock", image: "mock:1", containerPort: 1, healthPath: "/health" },
        env: (endpoint: string) => ({ MOCK_ENDPOINT_URL: endpoint }),
      },
    });

    delete process.env.MOCK_ENDPOINT_URL;
    await deployStack(harness(nativeApply, { plugins: [plugin] }));

    expect(seenDuringApply).toBe("http://localhost:9999");
    // Scoped to the run — nothing leaks into the suite's own process env.
    expect(process.env.MOCK_ENDPOINT_URL).toBeUndefined();
  });

  test("an ambient endpoint var wins over the declared endpoint", async () => {
    await writeProject(dir);
    let seenDuringApply: string | undefined;
    const nativeApply = vi.fn(async (_args: Record<string, unknown>) => {
      seenDuringApply = process.env.MOCK_ENDPOINT_URL;
      return { applied: 1, pruned: 0, notAttempted: 0 };
    });
    const plugin = createMockPlugin({
      name: "mock",
      emulator: {
        spec: { name: "chant-mock", image: "mock:1", containerPort: 1, healthPath: "/health" },
        env: (endpoint: string) => ({ MOCK_ENDPOINT_URL: endpoint }),
      },
    });

    process.env.MOCK_ENDPOINT_URL = "http://ambient:1234";
    try {
      await deployStack(harness(nativeApply, { plugins: [plugin] }));
    } finally {
      delete process.env.MOCK_ENDPOINT_URL;
    }
    expect(seenDuringApply).toBe("http://ambient:1234");
  });

  test("destroy sweeps exactly the nonce'd env, marker-scoped", async () => {
    await writeProject(dir);
    const nativeApply = vi.fn(async (_args: Record<string, unknown>) => ({ applied: 1, pruned: 0, notAttempted: 0 }));
    const teardownOwned = vi.fn(async (args: { environment: string; marker: { stack: string; env?: string } }) => ({
      candidates: [
        {
          name: "bucket",
          type: "Mock::Bucket",
          marker: { stack: args.marker.stack, env: args.marker.env! },
        },
      ],
    }));
    const executeTeardown = vi.fn(
      async (): Promise<TeardownExecution> => ({
        outcomes: [{ name: "bucket", outcome: "deleted" }],
      }),
    );
    const plugin = createMockPlugin({ name: "mock", teardownOwned, executeTeardown });

    const stack = await deployStack(harness(nativeApply, { plugins: [plugin] }));
    const report = await stack.destroy();

    expect(teardownOwned).toHaveBeenCalledWith({
      environment: stack.env,
      marker: { stack: "harness-fixture", env: stack.env },
    });
    expect(report.environment).toBe(stack.env);
    expect(report.stack).toBe("harness-fixture");
    expect(report.outcomes).toEqual([
      expect.objectContaining({ name: "bucket", outcome: "deleted" }),
    ]);
  });

  test("teardown holes surface as a thrown TeardownIncompleteError", async () => {
    await writeProject(dir);
    const nativeApply = vi.fn(async (_args: Record<string, unknown>) => ({ applied: 1, pruned: 0, notAttempted: 0 }));
    const teardownOwned = vi.fn(async () => ({
      candidates: [],
      holes: [{ name: "bucket", reason: "read-failed" as const, detail: "connection refused" }],
    }));
    const plugin = createMockPlugin({ name: "mock", teardownOwned, executeTeardown: async () => ({ outcomes: [] }) });

    const stack = await deployStack(harness(nativeApply, { plugins: [plugin] }));
    const err = await stack.destroy().then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TeardownIncompleteError);
    expect((err as TeardownIncompleteError).message).toContain("hole");
    expect((err as TeardownIncompleteError).report.plan.holes).toHaveLength(1);
  });

  test("a failed delete surfaces as a thrown TeardownIncompleteError", async () => {
    await writeProject(dir);
    const nativeApply = vi.fn(async (_args: Record<string, unknown>) => ({ applied: 1, pruned: 0, notAttempted: 0 }));
    const teardownOwned = vi.fn(async (args: { marker: { stack: string; env?: string } }) => ({
      candidates: [{ name: "bucket", type: "Mock::Bucket", marker: { stack: args.marker.stack, env: args.marker.env! } }],
    }));
    const executeTeardown = vi.fn(
      async (): Promise<TeardownExecution> => ({
        outcomes: [{ name: "bucket", outcome: "failed", detail: "still in use" }],
      }),
    );
    const plugin = createMockPlugin({ name: "mock", teardownOwned, executeTeardown });

    const stack = await deployStack(harness(nativeApply, { plugins: [plugin] }));
    const err = await stack.destroy().then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TeardownIncompleteError);
    expect((err as TeardownIncompleteError).message).toContain("still in use");
  });

  test("a failed apply rejects with the local executor's failure", async () => {
    await writeProject(dir);
    const nativeApply = vi.fn(async (_args: Record<string, unknown>) => {
      throw new Error("emulator not reachable");
    });

    await expect(deployStack(harness(nativeApply, { profiles: { longInfra: { retry: { maximumAttempts: 1 } } } })))
      .rejects.toThrow(/deploy-test-unit/);
    expect(nativeApply).toHaveBeenCalled();
  });

  test("an environment the project does not declare is refused with the test-* hint", async () => {
    await writeProject(dir, { environments: ["dev", "prod"] });
    const nativeApply = vi.fn(async (_args: Record<string, unknown>) => ({ applied: 1, pruned: 0, notAttempted: 0 }));

    await expect(deployStack(harness(nativeApply))).rejects.toThrow(/"test-\*" pattern/);
    expect(nativeApply).not.toHaveBeenCalled();
  });

  test("an explicit env overrides the derived name", async () => {
    await writeProject(dir);
    const nativeApply = vi.fn(async (_args: Record<string, unknown>) => ({ applied: 1, pruned: 0, notAttempted: 0 }));

    const stack = await deployStack(harness(nativeApply, { env: "test-pinned" }));

    expect(stack.env).toBe("test-pinned");
  });

  test("a project without ownership.stack is refused before anything deploys", async () => {
    await writeProject(dir, { ownership: undefined });
    const nativeApply = vi.fn(async (_args: Record<string, unknown>) => ({ applied: 1, pruned: 0, notAttempted: 0 }));

    await expect(deployStack(harness(nativeApply))).rejects.toThrow(/ownership\.stack/);
    expect(nativeApply).not.toHaveBeenCalled();
  });

  test("a project whose outputs have no apply target is refused loudly", async () => {
    await writeProject(dir);
    const nativeApply = vi.fn(async (_args: Record<string, unknown>) => ({ applied: 1, pruned: 0, notAttempted: 0 }));

    await expect(deployStack(harness(nativeApply, { applyTargets: {} }))).rejects.toThrow(/nothing to deploy/);
    expect(nativeApply).not.toHaveBeenCalled();
  });
});
