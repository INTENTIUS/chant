import { describe, it, expect } from "vitest";
import { observeResources } from "./observe";
import { observation } from "../observation";
import type { ObservationLexicon, ResourceMetadata } from "../lexicon";
import type { BuildResult } from "../build";

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
    expect(Object.keys(observations[0].resources).sort()).toEqual(["db-a", "db-b"]);
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
