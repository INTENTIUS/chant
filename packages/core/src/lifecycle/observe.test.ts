import { describe, it, expect, vi } from "vitest";
import { observeResources } from "./observe";
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

  it("collects a throwing plugin into errors instead of failing the whole graph", async () => {
    const plugins = [
      awsPlugin(() => { throw new Error("access denied"); }),
    ];
    const { observations, errors } = await observeResources("prod", plugins, mockBuild());
    expect(observations).toEqual([]);
    expect(errors).toEqual(["aws: access denied"]);
  });

  it("skips plugins with no describeResources and drops empty results", async () => {
    const empty = awsPlugin(() => ({}));
    const noObserve = { name: "gitlab", serializer: {} } as unknown as ObservationLexicon;
    const { observations } = await observeResources("prod", [empty, noObserve], mockBuild());
    expect(observations).toEqual([]);
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
        // Different resources per stack — the multi-stack, per-component case.
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
    expect(Object.keys(observations[0].resources).sort()).toEqual(["s1::db-a", "s2::db-b"]);
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
