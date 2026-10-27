/**
 * #4522 on the aws lexicon: the reference catalog over an indexed fixture
 * with a known topology (instance, security group, subnet, route table,
 * internet gateway), in Cloud Control's CloudFormation property shape.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GraphIR, IREdge } from "@intentius/chant/graph-ir";
import { typeListing, type ListingLexicon, type ListingResult } from "@intentius/chant/lifecycle/type-listing";
import { deriveEdges } from "@intentius/chant/lifecycle/derive-edges";
import { CapabilityEngine } from "@intentius/chant/capabilities/matcher";
import { buildView, displayName } from "@intentius/chant/capabilities/view";
import { resolvePacks, shippedRules } from "@intentius/chant/capabilities/catalog";
import { awsCapabilityPack } from "./capabilities/pack";
import { awsKindForListedType } from "./listed-types";
import { awsReferenceCatalog } from "./reference-catalog";
import { awsPlugin } from "./plugin";

const here = import.meta.dirname;
const surface = JSON.parse(readFileSync(join(here, "..", "surface.snapshot.json"), "utf-8")) as {
  entries: Record<string, { kind: string; resourceType: string }>;
};
const KINDS: ReadonlySet<string> = new Set(
  Object.values(surface.entries).filter((e) => e.kind === "resource").map((e) => e.resourceType),
);
const listing = JSON.parse(readFileSync(join(here, "testdata", "indexed", "topology.listing.json"), "utf-8")) as ListingResult;

const aws: ListingLexicon = {
  name: awsPlugin.name,
  deepNormalizationHooks: awsPlugin.deepNormalizationHooks,
  listedTypes: { ...awsPlugin.listedTypes!, kindFor: (t) => awsKindForListedType(t, KINDS) },
};
const doc = deriveEdges(typeListing(listing, [aws]), [{ name: "aws", referenceCatalog: awsPlugin.referenceCatalog }]);
const short = (e: IREdge) => `${displayName(e.from)} -> ${displayName(e.to)} [${e.viaAttr}] ${e.relation}`;

// Hand-checked against the fixture. displayName keeps the native id's last
// path segment, so the route `rtb-0pub|0.0.0.0/0` reads as `0`.
const EXPECTED = [
  "IGW|vpc-0a1 -> igw-0a1 [InternetGatewayId] reference",
  "IGW|vpc-0a1 -> vpc-0a1 [VpcId] reference",
  "i-0batch -> sg-0web [SecurityGroupIds] reference",
  "i-0batch -> subnet-0priv [SubnetId] containment",
  "i-0web -> sg-0web [SecurityGroupIds] reference",
  "i-0web -> subnet-0pub [SubnetId] containment",
  "0 -> igw-0a1 [GatewayId] reference",
  "0 -> rtb-0pub [RouteTableId] reference",
  "rtb-0pub -> vpc-0a1 [VpcId] containment",
  "rtbassoc-0pub -> rtb-0pub [RouteTableId] reference",
  "rtbassoc-0pub -> subnet-0pub [SubnetId] reference",
  "sg-0db -> sg-0web [SecurityGroupIngress] reference",
  "sg-0db -> vpc-0a1 [VpcId] containment",
  "sg-0web -> vpc-0a1 [VpcId] containment",
  "subnet-0priv -> vpc-0a1 [VpcId] containment",
  "subnet-0pub -> shop [Tags] reference",
  "subnet-0pub -> vpc-0a1 [VpcId] containment",
].sort();

describe("derived edges over the aws topology fixture", () => {
  it("produces the topology's edges, each labelled derived with its rule", () => {
    expect(doc.graph.edges.map(short).sort()).toEqual(EXPECTED);
    for (const e of doc.graph.edges) {
      expect(e.origin).toBe("derived");
      expect(e.grain).toBe("property");
      expect(e.rule).toMatch(/^aws:AWS::[A-Za-z0-9]+::[A-Za-z0-9]+:/);
    }
    expect(doc.graph.dangling).toBeUndefined();
    expect((doc.notes ?? []).filter((n) => n.kind === "ambiguous-reference" || n.kind === "no-catalog")).toEqual([]);
  });

  it("names the rule that drew each edge", () => {
    const rules = new Set(doc.graph.edges.map((e) => e.rule));
    expect(rules).toContain("aws:AWS::EC2::Instance:SubnetId");
    expect(rules).toContain("aws:AWS::EC2::Route:GatewayId");
    expect(rules).toContain("aws:AWS::EC2::VPCGatewayAttachment:InternetGatewayId");
    expect(rules).toContain("aws:AWS::EC2::SecurityGroup:SecurityGroupIngress[].SourceSecurityGroupId");
    expect(rules).toContain("aws:AWS::EC2::Subnet:tag:kubernetes.io/cluster/");
  });

  it("boxes subnets, route tables and security groups in their VPC", () => {
    const vpc = doc.graph.nodes.find((n) => n.nativeId === "vpc-0a1")!.id;
    expect(doc.graph.groups.byContainer?.[vpc]?.map(displayName).sort()).toEqual(["rtb-0pub", "sg-0db", "sg-0web", "subnet-0priv", "subnet-0pub"]);
  });

  it("internet-reachable answers the same over the index as over the declared graph", () => {
    const n = (id: string, kind: string, attrs: Record<string, unknown>) => ({ id, kind, lexicon: "aws", attrs });
    const ref = (from: string, to: string, viaAttr: string): IREdge => ({ from, to, kind: "ref", viaAttr });
    // The same estate as CloudFormation source declares it: references are AttrRefs, named by property.
    const declared: GraphIR = {
      nodes: [
        n("vpc-0a1", "AWS::EC2::VPC", { CidrBlock: "10.0.0.0/16" }),
        n("subnet-0pub", "AWS::EC2::Subnet", { CidrBlock: "10.0.1.0/24" }),
        n("subnet-0priv", "AWS::EC2::Subnet", { CidrBlock: "10.0.2.0/24" }),
        n("igw-0a1", "AWS::EC2::InternetGateway", {}),
        n("rtb-0pub", "AWS::EC2::RouteTable", {}),
        n("route", "AWS::EC2::Route", { DestinationCidrBlock: "0.0.0.0/0" }),
        n("rtbassoc-0pub", "AWS::EC2::SubnetRouteTableAssociation", {}),
        n("sg-0web", "AWS::EC2::SecurityGroup", { GroupDescription: "web", SecurityGroupIngress: [{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, CidrIp: "0.0.0.0/0" }] }),
        n("i-0web", "AWS::EC2::Instance", { ImageId: "ami-0abc", InstanceType: "t3.micro" }),
        n("i-0batch", "AWS::EC2::Instance", { ImageId: "ami-0abc", InstanceType: "t3.micro" }),
      ],
      edges: [
        ref("subnet-0pub", "vpc-0a1", "VpcId"),
        ref("subnet-0priv", "vpc-0a1", "VpcId"),
        ref("rtb-0pub", "vpc-0a1", "VpcId"),
        ref("route", "rtb-0pub", "RouteTableId"),
        ref("route", "igw-0a1", "GatewayId"),
        ref("rtbassoc-0pub", "subnet-0pub", "SubnetId"),
        ref("rtbassoc-0pub", "rtb-0pub", "RouteTableId"),
        ref("sg-0web", "vpc-0a1", "VpcId"),
        ref("i-0web", "subnet-0pub", "SubnetId"),
        ref("i-0web", "sg-0web", "SecurityGroupIds"),
        ref("i-0batch", "subnet-0priv", "SubnetId"),
        ref("i-0batch", "sg-0web", "SecurityGroupIds"),
      ],
      groups: {},
    };
    const answer = (g: GraphIR) => {
      const e = new CapabilityEngine(buildView(g, resolvePacks([awsCapabilityPack])), shippedRules().rules);
      return [...e.set("internet-reachable", e.bind("internet-reachable", [] as never)).keys()].map(displayName).sort();
    };
    expect(answer(declared)).toEqual(["i-0web"]);
    expect(answer(doc.graph)).toEqual(answer(declared));
  });
});

describe("the aws catalog over indexed nodes", () => {
  it("gives every untargeted rule a target kind for indexed nodes, and keeps it untargeted for enrichLiveAttrs", () => {
    const untargeted = awsReferenceCatalog.refs.filter((r) => r.targetKind === undefined);
    expect(untargeted).toHaveLength(19);
    expect(untargeted.filter((r) => r.indexedTargetKind === undefined)).toEqual([]);
  });

  it("keys every identity and target to a kind the lexicon has", () => {
    const kinds = [
      ...awsReferenceCatalog.identities.map((i) => i.kind),
      ...awsReferenceCatalog.refs.flatMap((r) => [r.from, r.targetKind ?? r.indexedTargetKind!]),
      ...(awsReferenceCatalog.tagRefs ?? []).map((r) => r.targetKind),
    ];
    expect([...new Set(kinds)].filter((k) => !KINDS.has(k))).toEqual([]);
  });
});
