import { describe, test, expect } from "vitest";
import { join } from "path";
import { cdkNotSupported, isCloudAssembly, readCloudAssembly } from "./assembly";
import { buildCdkGraph, constructLevel, dummyAssemblyReason } from "./graph";
import { CFN_TIER_MAP, isScaffoldingParameter, resolveCfnTier } from "./tier-map";
import { AWS_CARVE_TYPES } from "../terraform/aws-resources";

const FIXTURES = join(__dirname, "__fixtures__");
const ASSEMBLY = join(FIXTURES, "cdk.out");
const DUMMY = join(FIXTURES, "cdk.out-dummy");

describe("cloud assembly detection", () => {
  test("a directory with a manifest and a synthesized template is an assembly", () => {
    expect(isCloudAssembly(ASSEMBLY)).toBe(true);
    expect(isCloudAssembly(DUMMY)).toBe(true);
  });

  test("a directory that is not one is not claimed", () => {
    // manifest.json alone is far too common a filename to claim on sight; a
    // Terraform estate and a missing directory are both plainly not assemblies.
    expect(isCloudAssembly(join(__dirname, "..", "terraform", "__fixtures__", "sample-estate"))).toBe(false);
    expect(isCloudAssembly(join(FIXTURES, "definitely-not-here"))).toBe(false);
  });

  test("the Terraform-only phases refuse an assembly by name", () => {
    const message = cdkNotSupported("./cdk.out", "emit");
    expect(message).toContain("carve emit");
    expect(message).toContain("carve advise --from ./cdk.out");
  });
});

describe("the CloudFormation tier map", () => {
  test("is the AWS carve-out table read from the other end", () => {
    // Every carvable Terraform type names a CloudFormation type, and that type
    // resolves to the same tier from this side. No second table to keep in step.
    for (const entry of AWS_CARVE_TYPES) {
      expect(resolveCfnTier(entry.nativeType)).toEqual({ tier: entry.tier, mapsTo: entry.nativeType });
    }
    expect(Object.keys(CFN_TIER_MAP).length).toBeGreaterThan(70);
  });

  test("an unmapped CloudFormation type resolves to nothing", () => {
    expect(resolveCfnTier("AWS::CloudFormation::Stack")).toBeNull();
    expect(resolveCfnTier("AWS::S3::BucketPolicy")).toBeNull();
  });

  test("synthesizer parameters are told apart from an author's", () => {
    expect(isScaffoldingParameter("BootstrapVersion")).toBe(true);
    expect(isScaffoldingParameter("AssetParameters1a2b3c4dS3BucketA1B2C3")).toBe(true);
    expect(isScaffoldingParameter("EnvName")).toBe(false);
  });
});

describe("construct levels", () => {
  test("classify by jsii class", () => {
    expect(constructLevel("aws-cdk-lib.aws_s3.CfnBucket")).toBe("l1");
    expect(constructLevel("aws-cdk-lib.aws_s3.Bucket")).toBe("l2");
    expect(constructLevel("@aws-cdk/aws-s3.Bucket")).toBe("l2");
    expect(constructLevel("constructs.Construct")).toBe("l3");
    expect(constructLevel("my-app.ApiConstruct")).toBe("l3");
    expect(constructLevel("aws-cdk-lib.NestedStack")).toBe("nested");
    expect(constructLevel("aws-cdk-lib.Stack")).toBe("container");
    expect(constructLevel(undefined)).toBe("unknown");
  });
});

describe("buildCdkGraph", () => {
  const { graph, signals, diagnostics } = buildCdkGraph(readCloudAssembly(ASSEMBLY));
  const addresses = graph.nodes.map((n) => n.address);
  const node = (address: string) => graph.nodes.find((n) => n.address === address);

  test("ranks constructs, not CloudFormation resources", () => {
    expect(addresses).toEqual([
      "AppStack/Api",
      "AppStack/Handler",
      "AppStack/Legacy",
      "AppStack/Reports.NestedStack",
      "DataStack/Assets",
      "DataStack/Table",
    ]);
  });

  test("one L2 emitting three resources is one node, with its members named", () => {
    expect(node("AppStack/Handler")).toMatchObject({ kind: "resource", type: "AWS::Lambda::Function" });
    expect(signals.get("AppStack/Handler")?.members?.map((m) => m.type)).toEqual([
      "AWS::Lambda::Function",
      "AWS::IAM::Policy",
      "AWS::IAM::Role",
    ]);
    // The role and the policy are not separately rankable — they carve with it.
    expect(addresses).not.toContain("AppStack/Handler/ServiceRole");
  });

  test("an L3 subtree is one Composite candidate, ranked as a module", () => {
    expect(node("AppStack/Api")).toMatchObject({ kind: "module" });
    expect(node("AppStack/Api")?.type).toBeUndefined();
    expect(signals.get("AppStack/Api")?.members).toHaveLength(3);
    expect(signals.get("AppStack/Api")?.notes?.join(" ")).toContain("Composite candidate");
    expect(addresses).not.toContain("AppStack/Api/Queue");
  });

  test("a bare L1 stands on its own", () => {
    expect(node("AppStack/Legacy")).toMatchObject({ kind: "resource", type: "AWS::S3::Bucket" });
  });

  test("synthesis scaffolding never appears", () => {
    expect(addresses.some((a) => a.includes("CDKMetadata"))).toBe(false);
    for (const members of [...signals.values()].map((s) => s.members ?? [])) {
      expect(members.some((m) => m.type === "AWS::CDK::Metadata")).toBe(false);
    }
  });

  test("references inside one construct are not edges", () => {
    // The bucket policy Refs its bucket and the function Refs its own role;
    // both are internal to a carve set, so neither is boundary work.
    const internal = graph.edges.filter((e) => e.from === e.to);
    expect(internal).toHaveLength(0);
    expect(graph.edges.filter((e) => e.from === "DataStack/Assets")).toHaveLength(0);
  });

  test("an intra-stack Ref is an edge carrying the property it sits in", () => {
    expect(graph.edges).toContainEqual({
      from: "AppStack/Handler",
      to: "AppStack/Api",
      attrs: ["Ref"],
      via: ["Environment"],
    });
  });

  test("Fn::ImportValue resolves through the exporting stack's Outputs", () => {
    // Not a dangling export name: the edge lands on the construct that
    // actually produces the value, in the other stack.
    expect(graph.edges).toContainEqual({
      from: "AppStack/Handler",
      to: "DataStack/Assets",
      attrs: ["Export"],
      via: ["PolicyDocument"],
      crossStack: true,
    });
  });

  test("an output whose export is imported is not counted a second time", () => {
    // DataStack exports the bucket ARN and AppStack imports it. That is one
    // dependency, already drawn between the two constructs, so the output
    // block does not also charge the bucket.
    const outputs = graph.edges.filter((e) => e.fromKind === "output");
    expect(outputs.map((e) => e.from)).toEqual(["output.AppStack.QueueUrl", "output.DataStack.TableName"]);
  });

  test("a stack output nobody imports is an output edge on what it reads", () => {
    expect(graph.edges).toContainEqual({
      from: "output.DataStack.TableName",
      to: "DataStack/Table",
      attrs: ["Ref"],
      via: ["Value"],
      fromKind: "output",
    });
  });

  test("a CloudFormation Condition or an author's parameter marks a construct dynamic", () => {
    expect(node("AppStack/Legacy")?.hasDynamic).toBe(true);
    expect(node("DataStack/Assets")?.hasDynamic).toBe(false);
  });

  test("an asset-backed construct carries a penalty and says why", () => {
    expect(signals.get("AppStack/Handler")?.penalties).toEqual({ asset: -10 });
    expect(signals.get("AppStack/Handler")?.notes?.join(" ")).toContain("Asset-backed (Code)");
  });

  test("a nested stack is disqualified rather than scored", () => {
    expect(signals.get("AppStack/Reports.NestedStack")?.disqualified).toContain("Nested stack");
  });

  test("a complete assembly has nothing to report about the read", () => {
    expect(diagnostics).toEqual([]);
  });
});

describe("a dummy-value assembly", () => {
  const assembly = readCloudAssembly(DUMMY);

  test("is recognized from the manifest's unresolved lookups", () => {
    const reason = dummyAssemblyReason(assembly);
    expect(reason).toContain("unresolved context lookup");
    expect(reason).toContain("vpc-provider");
  });

  test("is recognized from a placeholder left in a template", () => {
    // The same verdict with the manifest's admission removed: the template
    // still holds the value the lookup would have replaced.
    const withoutMissing = { ...assembly, manifest: { ...assembly.manifest, missing: [] } };
    expect(dummyAssemblyReason(withoutMissing)).toContain("vpc-12345678");
  });

  test("disqualifies every construct in it", () => {
    const { signals } = buildCdkGraph(assembly);
    expect(signals.size).toBeGreaterThan(0);
    for (const signal of signals.values()) expect(signal.disqualified).toContain("unresolved context lookup");
  });

  test("without tree.json, grouping falls back to the construct path and says so", () => {
    const { graph, diagnostics } = buildCdkGraph(assembly);
    expect(graph.nodes.map((n) => n.address)).toEqual(["LookupStack/AppBucket", "LookupStack/AppSg"]);
    expect(diagnostics.join(" ")).toContain("No tree.json");
  });
});
