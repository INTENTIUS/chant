import { describe, test, expect, vi } from "vitest";
import { deepDiffForLexicon, diffDeepObservation, mergeDeepObservations, observeDeep } from "./deep-observe";
import { deepObservation, type DeepNormalizationHooks } from "../deep-observation";
import type { ObservationLexicon } from "../lexicon";

const entities = (
  record: Record<string, { entityType: string; props: Record<string, unknown> }>,
): Map<string, { entityType: string; props: Record<string, unknown> }> => new Map(Object.entries(record));

/** Minimal plugin shell — only the observation surface matters here. */
const pluginWith = (over: Partial<ObservationLexicon>): ObservationLexicon =>
  ({ name: "test", serializer: {} , ...over } as unknown as ObservationLexicon);

describe("observeDeep", () => {
  test("a lexicon with no deep reader observes nothing and claims nothing", async () => {
    const result = await observeDeep(pluginWith({}), {
      environment: "prod",
      buildOutput: "",
      entities: entities({ a: { entityType: "T", props: {} } }),
    });
    expect(result).toEqual({ resources: {}, unobserved: {} });
  });

  test("a thrown reader becomes read-failed for every declared entity, never an empty tree", async () => {
    const result = await observeDeep(
      pluginWith({
        observeResourcesDeep: () => Promise.reject(new Error("kubeconfig has no current context")),
      }),
      {
        environment: "prod",
        buildOutput: "",
        entities: entities({ a: { entityType: "T", props: {} }, b: { entityType: "U", props: {} } }),
      },
    );
    expect(result.resources).toEqual({});
    expect(result.unobserved.a).toEqual({
      type: "T",
      reason: "read-failed",
      detail: "kubeconfig has no current context",
    });
    expect(Object.keys(result.unobserved)).toEqual(["a", "b"]);
  });

  test("multi-stack reads merge with present beating not-observed", async () => {
    const reader = vi.fn(async (opts: { stack?: string }) =>
      opts.stack === "one"
        ? deepObservation({}, { a: { reason: "read-failed", detail: "not in this stack" } })
        : deepObservation({ a: { type: "T", properties: { A: 1 } } }),
    );
    const result = await observeDeep(pluginWith({ observeResourcesDeep: reader as never }), {
      environment: "prod",
      buildOutput: "",
      entities: entities({ a: { entityType: "T", props: {} } }),
      componentStacks: ["one", "two"],
    });
    expect(result.unobserved).toEqual({});
    expect(result.resources.a.properties).toEqual({ A: 1 });
  });

  test("passes the declared entity names through to the reader", async () => {
    const reader = vi.fn(async () => deepObservation({}));
    await observeDeep(pluginWith({ observeResourcesDeep: reader as never }), {
      environment: "prod",
      buildOutput: "out",
      entities: entities({ a: { entityType: "T", props: {} } }),
      owned: true,
    });
    expect(reader).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "prod", buildOutput: "out", entityNames: ["a"], owned: true }),
    );
  });
});

describe("mergeDeepObservations", () => {
  test("a resource found in any part is present everywhere", () => {
    const merged = mergeDeepObservations([
      { resources: {}, unobserved: { a: { reason: "read-failed" } } },
      { resources: { a: { type: "T", properties: {} } }, unobserved: {} },
    ]);
    expect(merged.unobserved).toEqual({});
    expect(Object.keys(merged.resources)).toEqual(["a"]);
  });
});

describe("diffDeepObservation", () => {
  const hooks: DeepNormalizationHooks = {
    prune(node) {
      // Server-populated everywhere.
      if (node.pattern === "Arn") return true;
      // A provider default, subtracted only where source is silent.
      return node.side === "live" && node.counterpart === "absent" && node.pattern === "Path" && node.value === "/";
    },
  };

  test("applies the lexicon's hooks to both sides", () => {
    const result = diffDeepObservation(
      entities({ r: { entityType: "AWS::IAM::Role", props: { Arn: "declared-arn", RoleName: "r" } } }),
      {
        resources: {
          r: { type: "AWS::IAM::Role", properties: { Arn: "arn:aws:iam::1:role/r", RoleName: "r", Path: "/" } },
        },
        unobserved: {},
      },
      hooks,
    );
    // Arn pruned on both sides; Path subtracted as an undeclared default.
    expect(result.drifted).toEqual([]);
    expect(result.unchanged).toEqual(["r"]);
  });

  test("a declared property at its default is still compared", () => {
    const result = diffDeepObservation(
      entities({ r: { entityType: "AWS::IAM::Role", props: { Path: "/" } } }),
      { resources: { r: { type: "AWS::IAM::Role", properties: { Path: "/team/" } } }, unobserved: {} },
      hooks,
    );
    expect(result.drifted[0].changes).toEqual([
      { path: "Path", kind: "changed", declared: "/", live: "/team/" },
    ]);
  });

  test("unevaluated declared props never read as drift", () => {
    class Sub {
      constructor(readonly t: string) {}
    }
    const result = diffDeepObservation(
      entities({ b: { entityType: "AWS::S3::Bucket", props: { BucketName: new Sub("${AWS::StackName}") } } }),
      { resources: { b: { type: "AWS::S3::Bucket", properties: { BucketName: "prod-data" } } }, unobserved: {} },
      hooks,
    );
    expect(result.drifted).toEqual([]);
  });
});

describe("deepDiffForLexicon", () => {
  test("an unreadable deep read surfaces as a hole with a reason, not as clean", async () => {
    const result = await deepDiffForLexicon(
      pluginWith({
        observeResourcesDeep: async () =>
          deepObservation({}, { a: { type: "T", reason: "no-credentials", detail: "token expired" } }),
      }),
      {
        environment: "prod",
        buildOutput: "",
        entities: entities({ a: { entityType: "T", props: { A: 1 } } }),
      },
    );
    expect(result.drifted).toEqual([]);
    expect(result.unobserved).toEqual([
      { name: "a", type: "T", reason: "no-credentials", detail: "token expired" },
    ]);
  });

  test("subtracts the accepted baseline it is handed", async () => {
    const plugin = pluginWith({
      observeResourcesDeep: async () =>
        deepObservation({ a: { type: "T", properties: { Extra: "accepted-value" } } }),
    });
    const opts = {
      environment: "prod",
      buildOutput: "",
      entities: entities({ a: { entityType: "T", props: {} } }),
    };
    const withoutBaseline = await deepDiffForLexicon(plugin, opts);
    expect(withoutBaseline.drifted[0].changes[0].path).toBe("Extra");

    const withBaseline = await deepDiffForLexicon(plugin, {
      ...opts,
      baseline: { a: { accepted: [{ path: "Extra", value: "accepted-value" }] } },
    });
    expect(withBaseline.drifted).toEqual([]);
    expect(withBaseline.accepted[0].changes[0].path).toBe("Extra");
  });
});
