import { describe, it, expect, vi } from "vitest";
import { observeResources, collectAmbient } from "./observe";
import { observation } from "../observation";
import type { ObservationLexicon, ResourceMetadata } from "../lexicon";
import type { BuildResult } from "../build";

// The per-stack scoped build (#1162) resolves each stack's `src` through the
// real `build`. Mock it so the test controls what each src yields — a stack
// whose src is scoped reports BARE entity names, matching the deployed
// LogicalResourceIds, not the whole-project build's disambiguated names.
const scopedBuilds: Record<string, string[]> = {};
vi.mock("../build", () => ({
  build: async (src: string): Promise<BuildResult> => {
    const names = scopedBuilds[src] ?? [];
    return {
      outputs: new Map<string, string>([["aws", "{}"]]),
      entities: new Map(names.map((n) => [n, { lexicon: "aws", entityType: "AWS::EC2::Instance", props: {} }])),
      errors: [],
    } as unknown as BuildResult;
  },
}));

function mockBuild(): BuildResult {
  return {
    outputs: new Map<string, string>([["aws", "{}"]]),
    entities: new Map([
      ["web-vpc", { lexicon: "aws", entityType: "AWS::EC2::VPC", props: {} }],
    ]),
    errors: [],
  } as unknown as BuildResult;
}

function awsPlugin(
  describe: (opts: { owned?: boolean; entityNames: string[] }) => Record<string, ResourceMetadata>,
): ObservationLexicon {
  return {
    name: "aws",
    serializer: {} as ObservationLexicon["serializer"],
    describeResources: async (opts) => describe(opts),
  } as ObservationLexicon;
}

describe("observeResources", () => {
  it("collects each plugin's resources as observations, defaulting owned=true", async () => {
    let sawOwned: boolean | undefined;
    const plugins = [
      awsPlugin(({ owned }) => {
        sawOwned = owned;
        return { "web-vpc": { type: "AWS::EC2::VPC", status: "CREATE_COMPLETE", physicalId: "vpc-1", ownership: "owned" } };
      }),
    ];
    const { observations, errors } = await observeResources("prod", plugins, mockBuild());
    expect(sawOwned).toBe(true); // managed-only
    expect(errors).toEqual([]);
    expect(observations).toHaveLength(1);
    expect(observations[0].lexicon).toBe("aws");
    expect(Object.keys(observations[0].resources)).toEqual(["web-vpc"]);
  });

  it("passes the declared entity names for scoping", async () => {
    let names: string[] = [];
    const plugins = [awsPlugin(({ entityNames }) => { names = entityNames; return {}; })];
    await observeResources("prod", plugins, mockBuild());
    expect(names).toEqual(["web-vpc"]);
  });

  it("threads the caller's namespace override to every lexicon, and only when given (#1629)", async () => {
    // A per-read option, not config: one project declares the GitOps binding
    // and another declares the objects, so which namespace to read from is a
    // property of the invocation. Lexicons with no namespace-like scope
    // receive it and ignore it.
    let seen: unknown = "unset";
    const plugins = [awsPlugin((opts) => { seen = (opts as { namespace?: string }).namespace; return {}; })];

    await observeResources("prod", plugins, mockBuild());
    expect(seen).toBeUndefined();

    await observeResources("prod", plugins, mockBuild(), { namespace: "app-b" });
    expect(seen).toBe("app-b");
  });

  it("keeps non-resource declarables out of the observation universe", async () => {
    // Outputs, parameters and serializer directives (gcp's defaultAnnotations)
    // have no `props` and no live counterpart — a declared name the reader can
    // never resolve would read as unobserved or missing forever.
    const buildResult = {
      outputs: new Map<string, string>([["aws", "{}"]]),
      entities: new Map<string, unknown>([
        ["web-vpc", { lexicon: "aws", entityType: "AWS::EC2::VPC", props: {} }],
        ["annotations", { lexicon: "aws", entityType: "chant:aws:directive" }],
      ]),
      errors: [],
    } as unknown as BuildResult;
    let names: string[] = [];
    const plugins = [awsPlugin(({ entityNames }) => { names = entityNames; return {}; })];
    await observeResources("prod", plugins, buildResult);
    expect(names).toEqual(["web-vpc"]);
  });

  it("collects a throwing plugin into errors instead of failing the whole graph, and reports its entities unobserved (#1089)", async () => {
    const plugins = [
      awsPlugin(() => { throw new Error("access denied"); }),
    ];
    const { observations, errors, warnings } = await observeResources("prod", plugins, mockBuild());
    expect(errors).toEqual(["aws: access denied"]);
    // The failed read is a hole, not an empty environment: every declared
    // entity comes back NOT-OBSERVED so nothing downstream reads it as absent.
    expect(observations).toHaveLength(1);
    expect(observations[0].resources).toEqual({});
    expect(observations[0].unobserved).toEqual({
      "web-vpc": { reason: "read-failed", type: "AWS::EC2::VPC", detail: "access denied" },
    });
    expect(warnings.join("\n")).toContain("web-vpc");
  });

  it("skips plugins with no describeResources and drops empty results", async () => {
    const empty = awsPlugin(() => ({}));
    const noObserve = { name: "gitlab", serializer: {} } as unknown as ObservationLexicon;
    const { observations } = await observeResources("prod", [empty, noObserve], mockBuild());
    expect(observations).toEqual([]);
  });

  // #1166 — this is exactly the "wrong endpoint" shape: AWS's stackDoesNotExist
  // branch returns an empty map (bare `{}`, no #1089 envelope) for a declared
  // entity nobody could actually observe. Before the fix this vanished with
  // neither an observation nor a warning; now it must say so.
  it("warns when a lexicon with declared entities observes zero resources and nothing is unobserved either (#1166)", async () => {
    const empty = awsPlugin(() => ({}));
    const { observations, warnings } = await observeResources("prod", [empty], mockBuild());
    expect(observations).toEqual([]); // still no observation pushed — nothing to graph
    expect(warnings).toEqual([
      'aws: 0 live resources for env "prod" (1 declared) — check the endpoint/credentials',
    ]);
  });

  it("does not warn about zero resources when the lexicon declares no entities at all", async () => {
    const empty = awsPlugin(() => ({}));
    const noEntities: BuildResult = { outputs: new Map(), entities: new Map(), errors: [] } as unknown as BuildResult;
    const { warnings } = await observeResources("prod", [empty], noEntities);
    expect(warnings).toEqual([]);
  });

  it("does not double-warn when the emptiness is already explained by #1089 unobserved", async () => {
    const plugin = {
      name: "aws",
      serializer: {} as ObservationLexicon["serializer"],
      describeResources: async () =>
        observation({}, { "web-vpc": { type: "AWS::EC2::VPC", reason: "no-binding" } }),
    } as unknown as ObservationLexicon;
    const { warnings } = await observeResources("prod", [plugin], mockBuild());
    // Only the #1089 per-entity warning — no separate "0 live resources" line.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no binding for this environment");
  });

  it("carries a plugin's own unobserved entities through (#1089)", async () => {
    const plugin = {
      name: "aws",
      serializer: {} as ObservationLexicon["serializer"],
      describeResources: async () =>
        observation({}, { "web-vpc": { type: "AWS::EC2::VPC", reason: "unsupported-kind" } }),
    } as unknown as ObservationLexicon;
    const { observations, warnings, errors } = await observeResources("prod", [plugin], mockBuild());
    expect(errors).toEqual([]);
    expect(observations[0].unobserved).toEqual({
      "web-vpc": { type: "AWS::EC2::VPC", reason: "unsupported-kind" },
    });
    expect(warnings[0]).toContain("no reader for this resource kind");
  });

  it("merges multi-stack reads with present > not-observed > absent (#1089)", async () => {
    const stacks = ["a", "b"];
    const plugin = {
      name: "aws",
      serializer: {} as ObservationLexicon["serializer"],
      describeResources: async (opts: { stack?: string }) =>
        opts.stack === "a"
          ? observation({}, { "web-vpc": { reason: "read-failed", detail: "stack a unreadable" } })
          : observation({ "web-vpc": { type: "AWS::EC2::VPC", status: "CREATE_COMPLETE" } }),
    } as unknown as ObservationLexicon;
    const { observations } = await observeResources("prod", [plugin], mockBuild(), { stacks });
    expect(Object.keys(observations[0].resources)).toEqual(["web-vpc"]);
    expect(observations[0].unobserved).toBeUndefined();
  });

  it("with no stacks: calls describeResources exactly once with no `stack` key (unchanged single-stack path)", async () => {
    const calls: Array<{ stack?: string }> = [];
    const plugins = [
      awsPlugin((opts) => {
        calls.push(opts as { stack?: string });
        return { "web-vpc": { type: "AWS::EC2::VPC", status: "CREATE_COMPLETE" } };
      }),
    ];
    const { observations } = await observeResources("prod", plugins, mockBuild());
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("stack");
    expect(Object.keys(observations[0].resources)).toEqual(["web-vpc"]);
  });

  it("with stacks: [s1, s2] — calls describeResources once per stack and unions the results", async () => {
    const calls: Array<string | undefined> = [];
    const plugins = [
      awsPlugin((opts) => {
        const stack = (opts as { stack?: string }).stack;
        calls.push(stack);
        // Different resources per stack — the multi-stack, per-component case
        // (#57 loomster). Bare-string stacks keep BARE ids (no `src` scope), so
        // the union is `db-a`+`db-b`, not stack-qualified: per-component ids are
        // already unique and behold reads them bare. Qualification is a scoped
        // (`src`) feature — see the per-stack src test below.
        const resources: Record<string, ResourceMetadata> =
          stack === "s1"
            ? { "db-a": { type: "AWS::RDS::DBInstance", status: "AVAILABLE" } }
            : { "db-b": { type: "AWS::RDS::DBInstance", status: "AVAILABLE" } };
        return resources;
      }),
    ];
    const { observations, errors } = await observeResources("prod", plugins, mockBuild(), { stacks: ["s1", "s2"] });
    expect(calls).toEqual(["s1", "s2"]);
    expect(errors).toEqual([]);
    expect(observations).toHaveLength(1);
    expect(Object.keys(observations[0].resources).sort()).toEqual(["db-a", "db-b"]);
  });

  it("with per-stack src (#1162): describeResources gets each stack's SCOPED bare names, not the whole-project build's names", async () => {
    const { resolve } = await import("node:path");
    // The whole-project build disambiguates colliding names by module path;
    // each stack's scoped src reports the bare names it actually deploys.
    scopedBuilds[resolve("east/src")] = ["server", "vpc"];
    scopedBuilds[resolve("west/src")] = ["server", "vpc"];

    const seen: Record<string, string[]> = {};
    const plugins = [
      awsPlugin((opts) => {
        const o = opts as { stack?: string; entityNames: string[] };
        seen[o.stack ?? "?"] = o.entityNames;
        // Echo one resource keyed by a bare name the deployed stack owns.
        return { server: { type: "AWS::EC2::Instance", status: "AVAILABLE", physicalId: `i-${o.stack}` } };
      }),
    ];
    // The whole-project buildResult carries DISAMBIGUATED names — proving the
    // scoped path overrides them rather than falling through to these.
    const wholeProject = {
      outputs: new Map<string, string>([["aws", "{}"]]),
      entities: new Map([
        ["EastServer", { lexicon: "aws", entityType: "AWS::EC2::Instance", props: {} }],
        ["WestServer", { lexicon: "aws", entityType: "AWS::EC2::Instance", props: {} }],
      ]),
      errors: [],
    } as unknown as BuildResult;

    const { observations } = await observeResources("floci", plugins, wholeProject, {
      stacks: [
        { name: "east", src: "east/src" },
        { name: "west", src: "west/src" },
      ],
    });

    // Each stack saw its own scoped bare names (matching deployed ids).
    expect(seen["east"]).toEqual(["server", "vpc"]);
    expect(seen["west"]).toEqual(["server", "vpc"]);
    // Observed nodes are stack-qualified, so the colliding `server` id is
    // distinct per stack and each carries its own physical id.
    expect(Object.keys(observations[0].resources).sort()).toEqual(["east::server", "west::server"]);
    expect(observations[0].resources["east::server"].physicalId).toBe("i-east");
    expect(observations[0].resources["west::server"].physicalId).toBe("i-west");
  });

  it("with an empty stacks array — falls back to the single unstacked call", async () => {
    const calls: Array<{ stack?: string }> = [];
    const plugins = [
      awsPlugin((opts) => {
        calls.push(opts as { stack?: string });
        return { "web-vpc": { type: "AWS::EC2::VPC", status: "CREATE_COMPLETE" } };
      }),
    ];
    await observeResources("prod", plugins, mockBuild(), { stacks: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("stack");
  });
});

describe("collectAmbient — one resource per region, not per account (#1416)", () => {
  const subnets = (region: string): Record<string, ResourceMetadata> =>
    Object.fromEntries(
      ["subnet-default-a", "subnet-default-b"].map((id) => [
        id,
        {
          type: "AWS::EC2::Subnet",
          status: "OBSERVED",
          physicalId: id,
          ambient: true,
          attributes: { region },
        } as ResourceMetadata,
      ]),
    );

  function ambientPlugin(): ObservationLexicon {
    return {
      name: "aws",
      describeResources: async () => ({}),
      observeAmbient: async (opts: { region?: string }) => subnets(opts.region ?? "us-east-1"),
    } as unknown as ObservationLexicon;
  }

  it("keeps every region's copy when the ids collide across regions", async () => {
    const found = await collectAmbient(ambientPlugin(), {
      environment: "prod",
      kinds: ["AWS::EC2::Subnet"],
      observed: {},
      stacks: [
        { name: "east", region: "us-east-1" },
        { name: "west1", region: "us-west-1" },
        { name: "west2", region: "us-west-2" },
      ],
      warnings: [],
    });
    expect(Object.keys(found).sort()).toEqual([
      "us-east-1::subnet-default-a",
      "us-east-1::subnet-default-b",
      "us-west-1::subnet-default-a",
      "us-west-1::subnet-default-b",
      "us-west-2::subnet-default-a",
      "us-west-2::subnet-default-b",
    ]);
  });

  it("still merges two stacks in the same region to one resource each", async () => {
    const found = await collectAmbient(ambientPlugin(), {
      environment: "prod",
      kinds: ["AWS::EC2::Subnet"],
      observed: {},
      stacks: [
        { name: "web", region: "us-east-1" },
        { name: "api", region: "us-east-1" },
      ],
      warnings: [],
    });
    expect(Object.keys(found).sort()).toEqual([
      "us-east-1::subnet-default-a",
      "us-east-1::subnet-default-b",
    ]);
  });

  it("leaves a single stack's ids bare — one region is not a merge", async () => {
    const found = await collectAmbient(ambientPlugin(), {
      environment: "prod",
      kinds: ["AWS::EC2::Subnet"],
      observed: {},
      stacks: [{ name: "main", region: "us-east-1" }],
      warnings: [],
    });
    expect(Object.keys(found).sort()).toEqual(["subnet-default-a", "subnet-default-b"]);
  });
});
