import { describe, test, expect, vi } from "vitest";
import { envTeardown } from "./env-teardown";
import type { ObservationLexicon, TeardownEnumeration, TeardownExecution } from "@intentius/chant/lexicon";
import type { ChantConfig } from "@intentius/chant/config";

/**
 * The activity is exercised through the REAL core engine
 * (`executeTeardown` from @intentius/chant/lifecycle/teardown) — only the
 * config and the lexicon plugin are injected. What's asserted is therefore
 * the whole path an Op step takes: guards, plan, execution, retry, report.
 */

const projectConfig = (overrides: Partial<ChantConfig> = {}): ChantConfig =>
  ({
    environments: ["dev", "prod"],
    ownership: { stack: "shop" },
    ...overrides,
  }) as ChantConfig;

const mockPlugin = (overrides: Record<string, unknown>): ObservationLexicon =>
  ({ name: "mock", ...overrides }) as unknown as ObservationLexicon;

const enumeration: TeardownEnumeration = {
  candidates: [
    { name: "web", type: "K8s::Apps::Deployment", physicalId: "web-1", marker: { stack: "shop", env: "dev" } },
    { name: "cache", type: "K8s::Core::Service", marker: { stack: "shop", env: "dev" } },
  ],
};

describe("envTeardown — the happy path through the real core engine", () => {
  test("plans by marker, deletes through the plugin, and reports counts", async () => {
    const teardownOwned = vi.fn(async () => enumeration);
    const executeTeardown = vi.fn(
      async (args: { candidates: Array<{ name: string }> }): Promise<TeardownExecution> => ({
        outcomes: args.candidates.map((c) => ({ name: c.name, outcome: "deleted" as const })),
      }),
    );
    const plugin = mockPlugin({ teardownOwned, executeTeardown });

    const result = await envTeardown({ env: "dev" }, undefined, {
      config: projectConfig(),
      plugins: [plugin],
    });

    expect(teardownOwned).toHaveBeenCalledWith({
      environment: "dev",
      marker: { stack: "shop", env: "dev" },
    });
    expect(executeTeardown).toHaveBeenCalledTimes(1);
    expect(executeTeardown.mock.calls[0]![0]).toMatchObject({
      environment: "dev",
      marker: { stack: "shop", env: "dev" },
    });
    expect(result.environment).toBe("dev");
    expect(result.stack).toBe("shop");
    expect(result.deleted).toBe(2);
    expect(result.notPrunable).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.holes).toBe(0);
    expect(result.report.outcomes.map((o) => o.outcome)).toEqual(["deleted", "deleted"]);
  });

  test("a candidate whose marker is foreign never reaches execution — core drops it", async () => {
    const teardownOwned = vi.fn(async (): Promise<TeardownEnumeration> => ({
      candidates: [
        { name: "mine", type: "T", marker: { stack: "shop", env: "dev" } },
        { name: "other-env", type: "T", marker: { stack: "shop", env: "prod" } },
      ],
    }));
    const executeTeardown = vi.fn(
      async (args: { candidates: Array<{ name: string }> }): Promise<TeardownExecution> => ({
        outcomes: args.candidates.map((c) => ({ name: c.name, outcome: "deleted" as const })),
      }),
    );

    const result = await envTeardown({ env: "dev" }, undefined, {
      config: projectConfig(),
      plugins: [mockPlugin({ teardownOwned, executeTeardown })],
    });

    expect(executeTeardown.mock.calls[0]![0].candidates.map((c) => c.name)).toEqual(["mine"]);
    expect(result.deleted).toBe(1);
  });
});

describe("envTeardown — guards (the CLI's guards, unchanged)", () => {
  test("refuses a prod-like environment without confirmProd: true, before any live read", async () => {
    const teardownOwned = vi.fn(async () => enumeration);
    await expect(
      envTeardown({ env: "prod" }, undefined, {
        config: projectConfig(),
        plugins: [mockPlugin({ teardownOwned })],
      }),
    ).rejects.toThrow(/looks like a production environment.*confirmProd: true/);
    expect(teardownOwned).not.toHaveBeenCalled();
  });

  test("confirmProd: true releases the prod guard", async () => {
    const teardownOwned = vi.fn(async (): Promise<TeardownEnumeration> => ({
      candidates: [{ name: "web", type: "T", marker: { stack: "shop", env: "prod" } }],
    }));
    const executeTeardown = vi.fn(async (): Promise<TeardownExecution> => ({
      outcomes: [{ name: "web", outcome: "deleted" }],
    }));

    const result = await envTeardown({ env: "prod", confirmProd: true }, undefined, {
      config: projectConfig(),
      plugins: [mockPlugin({ teardownOwned, executeTeardown })],
    });

    expect(result.deleted).toBe(1);
  });

  test("a truthy-but-not-true confirmProd does not count", async () => {
    await expect(
      envTeardown({ env: "prod", confirmProd: "yes" as unknown as boolean }, undefined, {
        config: projectConfig(),
        plugins: [],
      }),
    ).rejects.toThrow(/confirmProd: true/);
  });

  test("refuses an environment the project does not declare", async () => {
    const teardownOwned = vi.fn(async () => enumeration);
    await expect(
      envTeardown({ env: "qa" }, undefined, {
        config: projectConfig(),
        plugins: [mockPlugin({ teardownOwned })],
      }),
    ).rejects.toThrow(/Unknown environment "qa"/);
    expect(teardownOwned).not.toHaveBeenCalled();
  });

  test("refuses a project with no ownership.stack — nothing to select on", async () => {
    await expect(
      envTeardown({ env: "dev" }, undefined, {
        config: projectConfig({ ownership: undefined }),
        plugins: [],
      }),
    ).rejects.toThrow(/ownership\.stack/);
  });
});

describe("envTeardown — failures fail the activity", () => {
  test("a candidate still failed after core's retry pass throws, naming it", async () => {
    const teardownOwned = vi.fn(async (): Promise<TeardownEnumeration> => ({
      candidates: [
        { name: "web", type: "T", marker: { stack: "shop", env: "dev" } },
        { name: "cache", type: "T", marker: { stack: "shop", env: "dev" } },
      ],
    }));
    const executeTeardown = vi.fn(
      async (args: { candidates: Array<{ name: string }> }): Promise<TeardownExecution> => ({
        outcomes: args.candidates.map((c) =>
          c.name === "web"
            ? { name: c.name, outcome: "failed" as const, detail: "409 conflict" }
            : { name: c.name, outcome: "deleted" as const },
        ),
      }),
    );

    await expect(
      envTeardown({ env: "dev" }, undefined, {
        config: projectConfig(),
        plugins: [mockPlugin({ teardownOwned, executeTeardown })],
      }),
    ).rejects.toThrow(/1 of 2 candidate\(s\) still failed.*mock\/web.*409 conflict/);
    // First pass over both, then core's one bounded retry pass over the failure.
    expect(executeTeardown).toHaveBeenCalledTimes(2);
    expect(executeTeardown.mock.calls[1]![0].candidates.map((c) => c.name)).toEqual(["web"]);
  });

  test("a lexicon that enumerates but cannot execute reports skipped, not clean", async () => {
    const teardownOwned = vi.fn(async (): Promise<TeardownEnumeration> => ({
      candidates: [{ name: "web", type: "T", marker: { stack: "shop", env: "dev" } }],
    }));

    const result = await envTeardown({ env: "dev" }, undefined, {
      config: projectConfig(),
      plugins: [mockPlugin({ teardownOwned })],
    });

    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.report.unimplemented).toEqual(["mock"]);
  });
});
