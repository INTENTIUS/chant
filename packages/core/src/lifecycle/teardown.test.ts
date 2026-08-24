import { describe, test, expect, vi } from "vitest";
import { createMockPlugin, staticObservation } from "@intentius/chant-test-utils";
import { planTeardown, executeTeardown } from "./teardown";
import { observation } from "../observation";
import type { ResourceMetadata, TeardownEnumeration, TeardownExecution } from "../lexicon";

const meta = (overrides: Partial<ResourceMetadata> = {}): ResourceMetadata => ({
  type: "K8s::Apps::Deployment",
  status: "READY",
  physicalId: "deploy-1",
  ...overrides,
});

describe("planTeardown — teardownOwned capability path", () => {
  test("returns the lexicon's candidates, attributed", async () => {
    const enumeration: TeardownEnumeration = {
      candidates: [
        { name: "web", type: "K8s::Apps::Deployment", physicalId: "web-1", marker: { stack: "shop", env: "dev" } },
        { name: "cache", type: "K8s::Core::Service", marker: { stack: "shop", env: "dev" } },
      ],
    };
    const teardownOwned = vi.fn(async () => enumeration);
    const plan = await planTeardown({
      environment: "dev",
      stack: "shop",
      plugins: [createMockPlugin({ name: "k8s", teardownOwned })],
    });

    expect(teardownOwned).toHaveBeenCalledWith({
      environment: "dev",
      marker: { stack: "shop", env: "dev" },
    });
    expect(plan.entries).toEqual([
      { lexicon: "k8s", name: "cache", type: "K8s::Core::Service", marker: { stack: "shop", env: "dev" } },
      { lexicon: "k8s", name: "web", type: "K8s::Apps::Deployment", physicalId: "web-1", marker: { stack: "shop", env: "dev" } },
    ]);
    expect(plan.holes).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  test("the capability wins over describeResources when both exist", async () => {
    const teardownOwned = vi.fn(async (): Promise<TeardownEnumeration> => ({
      candidates: [{ name: "a", type: "T", marker: { stack: "shop", env: "dev" } }],
    }));
    const describeResources = vi.fn(async () => ({}));
    const plan = await planTeardown({
      environment: "dev",
      stack: "shop",
      plugins: [createMockPlugin({ name: "k8s", teardownOwned, describeResources })],
    });
    expect(plan.entries).toHaveLength(1);
    expect(describeResources).not.toHaveBeenCalled();
  });

  test("drops a candidate whose marker is foreign-stack or foreign-env — a buggy lexicon cannot widen the set", async () => {
    const plan = await planTeardown({
      environment: "dev",
      stack: "shop",
      plugins: [
        createMockPlugin({
          name: "k8s",
          teardownOwned: async () => ({
            candidates: [
              { name: "mine", type: "T", marker: { stack: "shop", env: "dev" } },
              { name: "other-stack", type: "T", marker: { stack: "blog", env: "dev" } },
              { name: "other-env", type: "T", marker: { stack: "shop", env: "prod" } },
              { name: "no-env", type: "T", marker: { stack: "shop" } },
            ],
          }),
        }),
      ],
    });
    expect(plan.entries.map((e) => e.name)).toEqual(["mine"]);
  });

  test("surfaces the lexicon's holes, attributed", async () => {
    const plan = await planTeardown({
      environment: "dev",
      stack: "shop",
      plugins: [
        createMockPlugin({
          name: "k8s",
          teardownOwned: async () => ({
            candidates: [],
            holes: [{ name: "crds", type: "K8s::CRD", reason: "unsupported-kind", detail: "no reader" }],
          }),
        }),
      ],
    });
    expect(plan.holes).toEqual([
      { lexicon: "k8s", name: "crds", type: "K8s::CRD", reason: "unsupported-kind", detail: "no reader" },
    ]);
  });

  test("a thrown enumeration becomes a whole-lexicon hole, never a clean lexicon", async () => {
    const plan = await planTeardown({
      environment: "dev",
      stack: "shop",
      plugins: [
        createMockPlugin({ name: "k8s", teardownOwned: async () => { throw new Error("no cluster binding"); } }),
      ],
    });
    expect(plan.entries).toEqual([]);
    expect(plan.holes).toEqual([
      { lexicon: "k8s", name: "*", reason: "read-failed", detail: "no cluster binding" },
    ]);
  });

  test("passes deployedStack and region through", async () => {
    const teardownOwned = vi.fn(async (): Promise<TeardownEnumeration> => ({ candidates: [] }));
    await planTeardown({
      environment: "dev",
      stack: "shop",
      deployedStack: "shop-network",
      region: "eu-west-1",
      plugins: [createMockPlugin({ name: "aws", teardownOwned })],
    });
    expect(teardownOwned).toHaveBeenCalledWith({
      environment: "dev",
      marker: { stack: "shop", env: "dev" },
      stack: "shop-network",
      region: "eu-west-1",
    });
  });
});

describe("planTeardown — describeResources fallback path", () => {
  test("selects only resources whose marker matches this stack and env", async () => {
    const plan = await planTeardown({
      environment: "dev",
      stack: "shop",
      plugins: [
        createMockPlugin({
          name: "k8s",
          describeResources: staticObservation({
            mine: meta({ marker: { stack: "shop", env: "dev" } }),
            foreignStack: meta({ marker: { stack: "blog", env: "dev" } }),
            foreignEnv: meta({ marker: { stack: "shop", env: "prod" } }),
            noEnvOnMarker: meta({ marker: { stack: "shop" } }),
            unmarked: meta(),
          }),
        }),
      ],
    });
    expect(plan.entries).toEqual([
      {
        lexicon: "k8s",
        name: "mine",
        type: "K8s::Apps::Deployment",
        physicalId: "deploy-1",
        marker: { stack: "shop", env: "dev" },
      },
    ]);
  });

  test("asks for owned resources with no declared entity list — stateless, no build", async () => {
    const describeResources = vi.fn(async () => ({}));
    await planTeardown({
      environment: "dev",
      stack: "shop",
      plugins: [createMockPlugin({ name: "k8s", describeResources })],
    });
    expect(describeResources).toHaveBeenCalledWith({
      environment: "dev",
      buildOutput: "",
      entityNames: [],
      entities: new Map(),
      owned: true,
    });
  });

  test("envelope unobserved entries become holes (#1089)", async () => {
    const plan = await planTeardown({
      environment: "dev",
      stack: "shop",
      plugins: [
        createMockPlugin({
          name: "k8s",
          describeResources: async () =>
            observation(
              { mine: meta({ marker: { stack: "shop", env: "dev" } }) },
              { hidden: { type: "K8s::CRD", reason: "unsupported-kind", detail: "no reader for kind" } },
            ),
        }),
      ],
    });
    expect(plan.entries).toHaveLength(1);
    expect(plan.holes).toEqual([
      { lexicon: "k8s", name: "hidden", type: "K8s::CRD", reason: "unsupported-kind", detail: "no reader for kind" },
    ]);
  });

  test("a thrown read becomes a whole-lexicon hole", async () => {
    const plan = await planTeardown({
      environment: "dev",
      stack: "shop",
      plugins: [
        createMockPlugin({ name: "azure", describeResources: async () => { throw new Error("az not found"); } }),
      ],
    });
    expect(plan.entries).toEqual([]);
    expect(plan.holes).toEqual([
      { lexicon: "azure", name: "*", reason: "read-failed", detail: "az not found" },
    ]);
  });
});

describe("planTeardown — lexicons with neither path", () => {
  test("are reported as skipped, so nothing-to-delete never means nobody-looked", async () => {
    const plan = await planTeardown({
      environment: "dev",
      stack: "shop",
      plugins: [createMockPlugin({ name: "helm" })],
    });
    expect(plan.entries).toEqual([]);
    expect(plan.skipped).toEqual(["helm"]);
  });
});

describe("planTeardown — aggregation", () => {
  test("merges entries and holes across lexicons, sorted by lexicon then name", async () => {
    const plan = await planTeardown({
      environment: "dev",
      stack: "shop",
      plugins: [
        createMockPlugin({
          name: "k8s",
          teardownOwned: async () => ({
            candidates: [{ name: "web", type: "K8s::Apps::Deployment", marker: { stack: "shop", env: "dev" } }],
          }),
        }),
        createMockPlugin({
          name: "gcp",
          describeResources: staticObservation({
            bucket: meta({ type: "GCP::Storage::Bucket", physicalId: "b-1", marker: { stack: "shop", env: "dev" } }),
          }),
        }),
        createMockPlugin({ name: "helm" }),
      ],
    });
    expect(plan.entries.map((e) => `${e.lexicon}/${e.name}`)).toEqual(["gcp/bucket", "k8s/web"]);
    expect(plan.skipped).toEqual(["helm"]);
    expect(plan.environment).toBe("dev");
    expect(plan.stack).toBe("shop");
  });
});

describe("executeTeardown — the execution half (#1222)", () => {
  const candidateWeb = { name: "web", type: "K8s::Apps::Deployment", marker: { stack: "shop", env: "dev" } };
  const candidateCache = { name: "cache", type: "K8s::Core::Service", marker: { stack: "shop", env: "dev" } };

  test("hands each lexicon its own candidates and reports the outcomes, attributed", async () => {
    const execute = vi.fn(async (): Promise<TeardownExecution> => ({
      outcomes: [
        { name: "cache", outcome: "deleted" },
        { name: "web", outcome: "not-prunable", detail: "identity changed under us" },
      ],
    }));
    const report = await executeTeardown({
      environment: "dev",
      stack: "shop",
      plugins: [
        createMockPlugin({
          name: "k8s",
          teardownOwned: async () => ({ candidates: [candidateWeb, candidateCache] }),
          executeTeardown: execute,
        }),
      ],
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({
      environment: "dev",
      marker: { stack: "shop", env: "dev" },
      candidates: [candidateCache, candidateWeb],
    });
    expect(report.outcomes).toEqual([
      { lexicon: "k8s", ...candidateCache, outcome: "deleted" },
      { lexicon: "k8s", ...candidateWeb, outcome: "not-prunable", detail: "identity changed under us" },
    ]);
    expect(report.unimplemented).toEqual([]);
  });

  test("reuses a handed-in plan instead of re-reading", async () => {
    const teardownOwned = vi.fn();
    const execute = vi.fn(async (): Promise<TeardownExecution> => ({
      outcomes: [{ name: "web", outcome: "deleted" }],
    }));
    const plan = {
      environment: "dev",
      stack: "shop",
      entries: [{ lexicon: "k8s", ...candidateWeb }],
      holes: [],
      skipped: [],
    };
    const report = await executeTeardown({
      environment: "dev",
      stack: "shop",
      plan,
      plugins: [createMockPlugin({ name: "k8s", teardownOwned, executeTeardown: execute })],
    });
    expect(teardownOwned).not.toHaveBeenCalled();
    expect(report.plan).toBe(plan);
    expect(report.outcomes[0].outcome).toBe("deleted");
  });

  test("a failure gets exactly one retry pass, and a retry success is marked", async () => {
    let calls = 0;
    const execute = vi.fn(async (options: { candidates: Array<{ name: string }> }): Promise<TeardownExecution> => {
      calls++;
      if (calls === 1) {
        return {
          outcomes: [
            { name: "cache", outcome: "deleted" },
            { name: "web", outcome: "failed", detail: "conflict" },
          ],
        };
      }
      // The retry pass gets only the failures.
      expect(options.candidates.map((c) => c.name)).toEqual(["web"]);
      return { outcomes: [{ name: "web", outcome: "deleted" }] };
    });
    const report = await executeTeardown({
      environment: "dev",
      stack: "shop",
      plugins: [
        createMockPlugin({
          name: "k8s",
          teardownOwned: async () => ({ candidates: [candidateWeb, candidateCache] }),
          executeTeardown: execute as never,
        }),
      ],
    });
    expect(calls).toBe(2);
    const web = report.outcomes.find((o) => o.name === "web")!;
    expect(web.outcome).toBe("deleted");
    expect(web.retried).toBe(true);
    const cache = report.outcomes.find((o) => o.name === "cache")!;
    expect(cache.outcome).toBe("deleted");
    expect(cache.retried).toBeUndefined();
  });

  test("a failure that survives the retry stays failed — reported, never silent", async () => {
    const execute = vi.fn(async (): Promise<TeardownExecution> => ({
      outcomes: [{ name: "web", outcome: "failed", detail: "still refused" }],
    }));
    const report = await executeTeardown({
      environment: "dev",
      stack: "shop",
      plugins: [
        createMockPlugin({
          name: "k8s",
          teardownOwned: async () => ({ candidates: [candidateWeb] }),
          executeTeardown: execute,
        }),
      ],
    });
    expect(execute).toHaveBeenCalledTimes(2); // one pass + one bounded retry, never a third
    expect(report.outcomes).toEqual([
      { lexicon: "k8s", ...candidateWeb, outcome: "failed", detail: "still refused", retried: true },
    ]);
  });

  test("a thrown execution fails all its candidates, then retries them once", async () => {
    let calls = 0;
    const execute = vi.fn(async (): Promise<TeardownExecution> => {
      calls++;
      if (calls === 1) throw new Error("api down");
      return { outcomes: [{ name: "web", outcome: "deleted" }, { name: "cache", outcome: "deleted" }] };
    });
    const report = await executeTeardown({
      environment: "dev",
      stack: "shop",
      plugins: [
        createMockPlugin({
          name: "k8s",
          teardownOwned: async () => ({ candidates: [candidateWeb, candidateCache] }),
          executeTeardown: execute,
        }),
      ],
    });
    expect(report.outcomes.every((o) => o.outcome === "deleted" && o.retried)).toBe(true);
  });

  test("a candidate the lexicon stays silent about is failed — silence is never success", async () => {
    const execute = vi.fn(async (): Promise<TeardownExecution> => ({
      outcomes: [{ name: "cache", outcome: "deleted" }],
    }));
    const report = await executeTeardown({
      environment: "dev",
      stack: "shop",
      plugins: [
        createMockPlugin({
          name: "k8s",
          teardownOwned: async () => ({ candidates: [candidateWeb, candidateCache] }),
          executeTeardown: execute,
        }),
      ],
    });
    const web = report.outcomes.find((o) => o.name === "web")!;
    expect(web.outcome).toBe("failed");
    expect(web.detail).toContain("no outcome");
  });

  test("an outcome for a name core never asked about is dropped", async () => {
    const execute = vi.fn(async (): Promise<TeardownExecution> => ({
      outcomes: [
        { name: "web", outcome: "deleted" },
        { name: "somebody-elses", outcome: "deleted" },
      ],
    }));
    const report = await executeTeardown({
      environment: "dev",
      stack: "shop",
      plugins: [
        createMockPlugin({
          name: "k8s",
          teardownOwned: async () => ({ candidates: [candidateWeb] }),
          executeTeardown: execute,
        }),
      ],
    });
    expect(report.outcomes.map((o) => o.name)).toEqual(["web"]);
  });

  test("a lexicon with candidates but no executeTeardown reports them skipped, loudly", async () => {
    const report = await executeTeardown({
      environment: "dev",
      stack: "shop",
      plugins: [
        createMockPlugin({
          name: "gcp",
          teardownOwned: async () => ({
            candidates: [{ name: "bucket", type: "GCP::Storage::Bucket", marker: { stack: "shop", env: "dev" } }],
          }),
        }),
      ],
    });
    expect(report.unimplemented).toEqual(["gcp"]);
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0].outcome).toBe("skipped");
    expect(report.outcomes[0].detail).toContain("gcp");
  });

  test("per-lexicon isolation: one lexicon's failure never blocks another's deletes", async () => {
    const report = await executeTeardown({
      environment: "dev",
      stack: "shop",
      plugins: [
        createMockPlugin({
          name: "fly",
          teardownOwned: async () => ({
            candidates: [{ name: "app", type: "Fly::Machines::App", marker: { stack: "shop", env: "dev" } }],
          }),
          executeTeardown: async () => { throw new Error("flaps down"); },
        }),
        createMockPlugin({
          name: "k8s",
          teardownOwned: async () => ({ candidates: [candidateWeb] }),
          executeTeardown: async () => ({ outcomes: [{ name: "web", outcome: "deleted" as const }] }),
        }),
      ],
    });
    expect(report.outcomes.find((o) => o.lexicon === "fly")!.outcome).toBe("failed");
    expect(report.outcomes.find((o) => o.lexicon === "k8s")!.outcome).toBe("deleted");
  });

  test("a plan entry naming a lexicon that is not loaded is skipped, not lost", async () => {
    const report = await executeTeardown({
      environment: "dev",
      stack: "shop",
      plan: {
        environment: "dev",
        stack: "shop",
        entries: [{ lexicon: "aws", name: "vpc", type: "AWS::EC2::VPC", marker: { stack: "shop", env: "dev" } }],
        holes: [],
        skipped: [],
      },
      plugins: [],
    });
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0].outcome).toBe("skipped");
    expect(report.outcomes[0].detail).toContain("aws");
  });
});
