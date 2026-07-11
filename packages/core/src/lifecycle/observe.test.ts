import { describe, it, expect } from "vitest";
import { observeResources } from "./observe";
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
});
