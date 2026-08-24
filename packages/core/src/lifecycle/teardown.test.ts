import { describe, test, expect, vi } from "vitest";
import { createMockPlugin, staticObservation } from "@intentius/chant-test-utils";
import { planTeardown } from "./teardown";
import { observation } from "../observation";
import type { ResourceMetadata, TeardownEnumeration } from "../lexicon";

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
