/**
 * #4524 on the aws lexicon: `chant import --index` over a fixture index.
 *
 * The fixture (testdata/indexed/import.listing.json) is a VPC with a subnet
 * and a security group in it, an ECS task definition whose task role is an
 * IAM role, an RDS instance whose master password the lister masked, a
 * bucket, and one object of a type the lexicon does not generate. It is
 * typed (#4521) and its edges derived (#4522, #4523) as `behold index` would
 * write it, then imported through the aws seam and CFGenerator, the codegen
 * `chant import <template>` uses.
 *
 * The emulator round trip (index, import, build, then the declared entities
 * bind to their indexed resources through #4523 with no drift) is a
 * maintainer run; the steps are in the #4524 issue comment.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { build } from "@intentius/chant/build";
import { MASKED } from "@intentius/chant/deep-observation";
import { deriveEdges } from "@intentius/chant/lifecycle/derive-edges";
import { awsDeclaredIdentity, awsIndexIdentity, type IdentityManifestEntry } from "./index-identity";
import type { IndexDocument } from "@intentius/chant/lifecycle/index-document";
import { declaredNodes, planIndexImport, type IndexImportSelection } from "@intentius/chant/lifecycle/index-import";
import { typeListing, type ListingLexicon, type ListingResult } from "@intentius/chant/lifecycle/type-listing";
import { indexImportReportJson, renderIndexImport } from "@intentius/chant/cli/commands/import-index";
import type { LexiconPlugin } from "@intentius/chant/lexicon";
import { awsImportProperties, createAwsIndexImport, isImportableAwsType } from "./index-import";
import { awsKindForListedType } from "./listed-types";
import { awsPlugin } from "./plugin";
import { awsSerializer } from "./serializer";

// The registry rows for the fixture's types: primaryIdentifier and the
// schema's readOnlyProperties, which codegen writes as `attrs`.
const ROWS: IdentityManifestEntry[] = [
  { resourceType: "AWS::EC2::VPC", kind: "resource", primaryIdentifier: ["VpcId"], attrs: { VpcId: "VpcId", CidrBlockAssociations: "CidrBlockAssociations", DefaultNetworkAcl: "DefaultNetworkAcl", DefaultSecurityGroup: "DefaultSecurityGroup", Ipv6CidrBlocks: "Ipv6CidrBlocks" } },
  { resourceType: "AWS::EC2::Subnet", kind: "resource", primaryIdentifier: ["SubnetId"], attrs: { SubnetId: "SubnetId", NetworkAclAssociationId: "NetworkAclAssociationId", Ipv6CidrBlocks: "Ipv6CidrBlocks" } },
  { resourceType: "AWS::EC2::SecurityGroup", kind: "resource", primaryIdentifier: ["Id"], attrs: { GroupId: "GroupId", Id: "Id" } },
  { resourceType: "AWS::IAM::Role", kind: "resource", primaryIdentifier: ["RoleName"], attrs: { Arn: "Arn", RoleId: "RoleId" } },
  { resourceType: "AWS::ECS::TaskDefinition", kind: "resource", primaryIdentifier: ["TaskDefinitionArn"], attrs: { TaskDefinitionArn: "TaskDefinitionArn" } },
  { resourceType: "AWS::RDS::DBInstance", kind: "resource", primaryIdentifier: ["DBInstanceIdentifier"], attrs: { DBInstanceArn: "DBInstanceArn", DbiResourceId: "DbiResourceId", Endpoint_Address: "Endpoint.Address", Endpoint_Port: "Endpoint.Port" } },
  { resourceType: "AWS::S3::Bucket", kind: "resource", primaryIdentifier: ["BucketName"], attrs: { Arn: "Arn", DomainName: "DomainName", RegionalDomainName: "RegionalDomainName", WebsiteURL: "WebsiteURL" } },
];
const MANIFEST: ReadonlyMap<string, IdentityManifestEntry> = new Map(ROWS.map((e) => [e.resourceType, e]));
const KINDS: ReadonlySet<string> = new Set(MANIFEST.keys());

const listingLexicon: ListingLexicon = {
  name: awsPlugin.name,
  deepNormalizationHooks: awsPlugin.deepNormalizationHooks,
  listedTypes: { ...awsPlugin.listedTypes!, kindFor: (t) => awsKindForListedType(t, KINDS) },
};
const identity = { ...awsIndexIdentity, declaredIdentity: (t: string, p: Record<string, unknown>) => awsDeclaredIdentity(t, p, MANIFEST) };
const importLexicon = { name: "aws", indexImport: createAwsIndexImport(MANIFEST), indexIdentity: identity };
// renderIndexImport needs the template generator, and the plan needs the seam with the test's registry rows.
const plugin = { ...awsPlugin, indexImport: importLexicon.indexImport } as LexiconPlugin;

const raw = readFileSync(join(import.meta.dirname, "testdata", "indexed", "import.listing.json"), "utf-8");

/** The fixture as `behold index` writes it: typed, then derived edges. */
function indexFrom(listing: ListingResult): IndexDocument {
  return deriveEdges(typeListing(listing, [listingLexicon]), [
    { name: "aws", referenceCatalog: awsPlugin.referenceCatalog, indexIdentity: identity },
  ]);
}
const doc = indexFrom(JSON.parse(raw) as ListingResult);
const ALL: IndexImportSelection = { all: true };

function importOf(d: IndexDocument, selection: IndexImportSelection, declared?: ReadonlyMap<string, string>) {
  const plan = planIndexImport([d], selection, [importLexicon], declared ? { declared } : {});
  const { files, warnings } = renderIndexImport(plan, [plugin]);
  return { plan, files, warnings };
}

/** Build the generated source and return the synthesized template. */
async function synth(files: Array<{ path: string; content: string }>): Promise<Record<string, any>> {
  const dir = mkdtempSync(join(import.meta.dirname, "../.index-import-tmp-"));
  try {
    const src = join(dir, "src");
    mkdirSync(src);
    for (const f of files) writeFileSync(join(src, f.path), f.content);
    const result = await build(src, [awsSerializer]);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    return JSON.parse(result.outputs.get("aws") as string);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const nodeById = new Map(doc.graph.nodes.map((n) => [n.id, n]));

describe("chant import --index on the aws fixture", () => {
  test("the edges the fixture should carry are derived", () => {
    const rules = doc.graph.edges.map((e) => e.rule);
    expect(rules).toContain("aws:AWS::EC2::Subnet:VpcId");
    expect(rules).toContain("aws:AWS::EC2::SecurityGroup:VpcId");
    expect(rules).toContain("aws:AWS::ECS::TaskDefinition:TaskRoleArn");
  });

  test("round trip: import, then synth, gives each resource the indexed properties", async () => {
    const { plan, files } = importOf(doc, ALL);
    expect(files.map((f) => f.path)).toEqual(["main.ts"]);
    const template = await synth(files);

    const imported = plan.report.resources.filter((r) => r.status === "imported");
    expect(imported.map((r) => r.identity.listedType).sort()).toEqual([
      "AWS::EC2::SecurityGroup",
      "AWS::EC2::Subnet",
      "AWS::EC2::VPC",
      "AWS::ECS::TaskDefinition",
      "AWS::IAM::Role",
      "AWS::RDS::DBInstance",
      "AWS::S3::Bucket",
    ]);
    const byLogical = new Map(imported.map((r) => [r.logicalId!, nodeById.get(r.node)!]));
    const params = new Set(plan.report.parameters.map((p) => p.name));

    // Each reference and parameter read back as the value it stands for.
    const resolveBack = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(resolveBack);
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (typeof o.Ref === "string" && Object.keys(o).length === 1) {
          if (params.has(o.Ref)) return MASKED;
          const n = byLogical.get(o.Ref);
          if (n) return n.nativeId;
        }
        if (Array.isArray(o["Fn::GetAtt"]) && Object.keys(o).length === 1) {
          const [id, attr] = o["Fn::GetAtt"] as [string, string];
          const n = byLogical.get(id);
          if (n && attr === "Arn") return n.facts?.cloudIds?.find((c) => c.kind === "arn")?.value;
        }
        return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolveBack(x)]));
      }
      return v;
    };

    for (const [logicalId, node] of byLogical) {
      const built = template.Resources[logicalId];
      expect(built.Type).toBe(node.kind);
      const expected = awsImportProperties(node.kind, node.attrs, MANIFEST);
      expect(resolveBack(built.Properties ?? {})).toEqual(expected);
    }
  });

  test("every imported resource builds with DeletionPolicy and UpdateReplacePolicy Retain (#4536)", async () => {
    const { plan, files } = importOf(doc, ALL);
    const template = await synth(files);
    for (const r of plan.report.resources.filter((x) => x.status === "imported")) {
      expect(template.Resources[r.logicalId!]).toMatchObject({ DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
    }
  });

  test("the same index and selection give byte-identical files, in any listing order", () => {
    const first = importOf(doc, ALL);
    const shuffled = JSON.parse(raw) as ListingResult;
    shuffled.resources = [...shuffled.resources].reverse();
    const again = importOf(indexFrom(shuffled), ALL);
    expect(again.files).toEqual(first.files);
    expect(indexImportReportJson(again.plan.report)).toBe(indexImportReportJson(first.plan.report));
    expect(importOf(doc, ALL).files).toEqual(first.files);
  });

  test("a masked secret is written as a NoEcho parameter, never as a value", async () => {
    const { plan, files } = importOf(doc, { types: ["AWS::RDS::DBInstance"] });
    const source = files[0].content;
    expect(source).not.toContain(MASKED);
    expect(plan.report.parameters).toHaveLength(1);
    const param = plan.report.parameters[0];
    expect(param.path).toBe("MasterUserPassword");
    expect(source).toContain(`fill in the parameter ${param.name}`);
    const template = await synth(files);
    expect(template.Parameters[param.name]).toMatchObject({ Type: "String", NoEcho: true });
    const db = plan.report.resources.find((r) => r.status === "imported")!;
    expect(template.Resources[db.logicalId!].Properties.MasterUserPassword).toEqual({ Ref: param.name });
    expect(JSON.stringify(template)).not.toContain(MASKED);
  });

  test("derived edges become Ref and GetAtt between imported resources", async () => {
    const { plan, files } = importOf(doc, ALL);
    const template = await synth(files);
    const logical = (type: string) => plan.report.resources.find((r) => r.identity.listedType === type)!.logicalId!;
    const vpc = logical("AWS::EC2::VPC");
    expect(template.Resources[logical("AWS::EC2::Subnet")].Properties.VpcId).toEqual({ Ref: vpc });
    expect(template.Resources[logical("AWS::EC2::SecurityGroup")].Properties.VpcId).toEqual({ Ref: vpc });
    expect(template.Resources[logical("AWS::ECS::TaskDefinition")].Properties.TaskRoleArn).toEqual({
      "Fn::GetAtt": [logical("AWS::IAM::Role"), "Arn"],
    });
    const subnet = plan.report.resources.find((r) => r.identity.listedType === "AWS::EC2::Subnet")!;
    expect(subnet.references).toContainEqual({
      path: "VpcId",
      target: "aws/000000000000/us-east-1/AWS::EC2::VPC/vpc-0imp",
      rule: "aws:AWS::EC2::Subnet:VpcId",
      written: "reference",
    });
  });

  test("an edge to a resource outside the selection stays a literal, with a comment naming the edge", () => {
    const { plan, files } = importOf(doc, { types: ["AWS::EC2::Subnet"] });
    const source = files[0].content;
    expect(source).toContain('"vpc-0imp"');
    expect(source).toMatch(/VpcId = "vpc-0imp" stays a literal: derived edge aws:AWS::EC2::Subnet:VpcId to aws\/000000000000\/us-east-1\/AWS::EC2::VPC\/vpc-0imp; the target is not in the selection/);
    const subnet = plan.report.resources[0];
    expect(subnet.references?.[0]).toMatchObject({ path: "VpcId", written: "literal", reason: "the target is not in the selection" });
  });

  test("aws: tags and read-only properties are left out", () => {
    const vpc = doc.graph.nodes.find((n) => n.kind === "AWS::EC2::VPC")!;
    const props = awsImportProperties(vpc.kind, vpc.attrs, MANIFEST);
    expect(props.VpcId).toBeUndefined();
    expect(props.Tags).toEqual([{ Key: "Name", Value: "shop" }]);
    const db = doc.graph.nodes.find((n) => n.kind === "AWS::RDS::DBInstance")!;
    expect(awsImportProperties(db.kind, db.attrs, MANIFEST).Endpoint).toBeUndefined();
  });

  test("a declared bucket is reported as declared, not imported again", () => {
    const declared = declaredNodes(
      [doc],
      new Map([["aws", [{ name: "assets", entityType: "AWS::S3::Bucket", props: { BucketName: "imp-assets" } }]]]),
      [importLexicon],
    );
    const { plan, files } = importOf(doc, ALL, declared);
    const bucket = plan.report.resources.find((r) => r.identity.listedType === "AWS::S3::Bucket")!;
    expect(bucket).toMatchObject({ status: "declared", entity: "assets" });
    expect(files[0].content).not.toContain("imp-assets");
  });

  test("an unmapped type is named as unsupported, with its identity and cloud ids in the report", () => {
    const { plan } = importOf(doc, ALL);
    const other = plan.report.resources.find((r) => r.identity.listedType === "AWS::Example::NotGenerated")!;
    expect(other.status).toBe("unsupported");
    expect(other.reason).toMatch(/no lexicon kind maps/);
    const role = plan.report.resources.find((r) => r.identity.listedType === "AWS::IAM::Role")!;
    expect(role.identity).toEqual({ substrate: "aws", scopeId: "000000000000", listedType: "AWS::IAM::Role", location: "global", nativeId: "imp-task-role" });
    expect(role.cloudIds).toContainEqual({ kind: "arn", value: "arn:aws:iam::000000000000:role/imp-task-role" });
    // The global role joins the only region, so one file holds everything.
    expect(plan.groups.map((g) => g.dir)).toEqual([""]);
  });

  test("a type outside the AWS organization imports when the registry has it (#4538)", () => {
    const rows = new Map(MANIFEST);
    rows.set("Alexa::ASK::Skill", { resourceType: "Alexa::ASK::Skill", kind: "resource", attrs: {} });
    const seam = createAwsIndexImport(rows);
    const skill = { id: "aws:Alexa::ASK::Skill:amzn1.ask.skill.1", kind: "Alexa::ASK::Skill", lexicon: "aws", attrs: { SkillPackage: { Overrides: {} } } };
    expect(seam.resource(skill)).toMatchObject({ type: "Alexa::ASK::Skill", properties: { SkillPackage: { Overrides: {} } } });
    expect(isImportableAwsType("Alexa::ASK::Skill", rows)).toBe(true);
    // Not in the registry, or not a CloudFormation type at all: refused.
    expect(seam.resource({ ...skill, kind: "Alexa::ASK::Other" })).toEqual({ unsupported: expect.stringMatching(/not a CloudFormation resource type/) });
    expect(isImportableAwsType("AWS::S3", rows)).toBe(false);
    // With no registry, the listed-type rule's shape check alone decides.
    expect(isImportableAwsType("Alexa::ASK::Skill", new Map())).toBe(true);
    expect(isImportableAwsType("not-a-type", new Map())).toBe(false);
  });

  test("the plugin declares the seam", () => {
    expect(awsPlugin.indexImport).toBeDefined();
  });
});
