/**
 * #4536: CloudFormation adoption over a fake CloudFormation client. The
 * IMPORT change set carries no markers and no stack tags, the UPDATE adds
 * them and must be tags only, each change set goes through the review, and
 * the plan refuses create-only tags, a type CloudFormation cannot import, a
 * resource with no DeletionPolicy, an extra resource and a stale adoption
 * file. Nothing reaches a cloud; the floci run is a maintainer run.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { indexDocumentDigest, indexScopeKey, indexVersionName, type CloudIndexScope, type IndexDocument } from "@intentius/chant/lifecycle/index-document";
import type { AdoptionFile } from "@intentius/chant/lifecycle/adoption-file";
import type { ImportabilityManifestEntry } from "../importable";
import {
  adoptIntoStack,
  cfnMarkerReview,
  cfnResourceIdentifier,
  markerChangeSetProblems,
  planCfnAdoption,
  type CfnAdoptionReview,
  type CfnTemplate,
} from "./cfn-adopt";
import type { CfnChange, CfnChangeSet, CfnCreateChangeSetArgs, CfnCreateImportChangeSetArgs, CloudFormationClient } from "./cloud-executor";

const SCOPE: CloudIndexScope = { kind: "cloud", substrate: "aws", scopeId: "000000000000", locations: ["us-east-1"], types: "*" };
const BUCKET = "aws/000000000000/us-east-1/AWS::S3::Bucket/web-logs";
const KEYPAIR = "aws/000000000000/us-east-1/AWS::EC2::KeyPair/deploy";
const ROUTE = "aws/000000000000/us-east-1/AWS::EC2::Route/rtb-1|0.0.0.0/0";
const graph = {
  version: 1 as const,
  nodes: [
    { id: BUCKET, kind: "AWS::S3::Bucket", lexicon: "aws", attrs: { BucketName: "web-logs" }, listedType: "AWS::S3::Bucket", location: "us-east-1", nativeId: "web-logs" },
    { id: KEYPAIR, kind: "AWS::EC2::KeyPair", lexicon: "aws", attrs: { KeyName: "deploy" }, listedType: "AWS::EC2::KeyPair", location: "us-east-1", nativeId: "deploy" },
    { id: ROUTE, kind: "AWS::EC2::Route", lexicon: "aws", attrs: {}, listedType: "AWS::EC2::Route", location: "us-east-1", nativeId: "rtb-1|0.0.0.0/0" },
  ],
  edges: [],
  groups: {},
};
const INDEX: IndexDocument = {
  index: "v1",
  stamp: { source: { kind: "cloud", name: "behold-lister" }, scope: SCOPE, scopeKey: indexScopeKey(SCOPE), observedAt: "2026-10-26T12:00:00Z", digest: indexDocumentDigest({ graph, coverage: [] }) },
  coverage: [],
  graph,
};
const ALL = ["create", "delete", "list", "read", "update"];
const MANIFEST = new Map<string, ImportabilityManifestEntry>([
  ["AWS::S3::Bucket", { resourceType: "AWS::S3::Bucket", kind: "resource", handlers: ALL, primaryIdentifier: ["BucketName"], tagging: { taggable: true, tagUpdatable: true, tagProperty: "Tags", tagShape: "list" } }],
  ["AWS::EC2::KeyPair", { resourceType: "AWS::EC2::KeyPair", kind: "resource", handlers: ALL, primaryIdentifier: ["KeyName"], tagging: { taggable: true, tagUpdatable: false, tagProperty: "Tags", tagShape: "list" } }],
  ["AWS::EC2::Route", { resourceType: "AWS::EC2::Route", kind: "resource", handlers: ALL, primaryIdentifier: ["RouteTableId", "DestinationCidrBlock"] }],
  ["AWS::IAM::Policy", { resourceType: "AWS::IAM::Policy", kind: "resource", handlers: ["create", "delete", "update"], primaryIdentifier: ["Id"] }],
]);
const MARKERS = [
  { Key: "chant:managed-by", Value: "chant" },
  { Key: "chant:stack", Value: "web" },
  { Key: "chant:env", Value: "prod" },
];

const adoption = (select: AdoptionFile["select"]): AdoptionFile => ({
  adopt: "v1",
  index: { scopeKey: INDEX.stamp.scopeKey, version: indexVersionName(INDEX.stamp.observedAt, INDEX.stamp.digest), digest: INDEX.stamp.digest },
  select,
});
const template = (): CfnTemplate => ({
  AWSTemplateFormatVersion: "2010-09-09",
  Metadata: { "chant:ownership": { "chant:managed-by": "chant", "chant:stack": "web", "chant:env": "prod" } },
  Resources: {
    BucketWebLogs: {
      Type: "AWS::S3::Bucket",
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: { BucketName: "web-logs", Tags: [{ Key: "team", Value: "shop" }, ...MARKERS] },
    },
  },
});
const bucketOnly = () => adoption([{ node: BUCKET, as: "BucketWebLogs", type: "AWS::S3::Bucket" }]);

interface Fake {
  cfn: CloudFormationClient;
  calls: string[];
  templates: Record<string, unknown>;
  imports: CfnCreateImportChangeSetArgs[];
}

function fakeCfn(opts: { importChanges?: CfnChange[]; markerChanges?: CfnChange[]; markerNoop?: boolean; noImport?: boolean } = {}): Fake {
  const calls: string[] = [];
  const templates: Record<string, unknown> = {};
  const imports: CfnCreateImportChangeSetArgs[] = [];
  let status = "REVIEW_IN_PROGRESS";
  let pending: "IMPORT" | "UPDATE" | undefined;
  const cs = (name: string, changes: CfnChange[], extra: Partial<CfnChangeSet> = {}): CfnChangeSet => ({ changeSetName: name, stackName: "web", status: "CREATE_COMPLETE", isCreate: false, changes, ...extra });
  const cfn: CloudFormationClient = {
    async createImportChangeSet(args) {
      calls.push("createImportChangeSet");
      imports.push(args);
      templates.import = JSON.parse(readFileSync(args.templatePath, "utf8"));
      pending = "IMPORT";
      const changes = opts.importChanges ?? args.resourcesToImport.map((r) => ({ action: "Import" as const, logicalResourceId: r.logicalResourceId, resourceType: r.resourceType, replacement: false }));
      return cs("cs-import", changes, { changeSetType: "IMPORT" });
    },
    async createChangeSet(args: CfnCreateChangeSetArgs) {
      calls.push("createChangeSet");
      templates.markers = JSON.parse(readFileSync(args.templatePath, "utf8"));
      pending = "UPDATE";
      if (opts.markerNoop) return cs("cs-markers", [], { status: "FAILED", statusReason: "The submitted information didn't contain changes." });
      return cs("cs-markers", opts.markerChanges ?? [{ action: "Modify", logicalResourceId: "BucketWebLogs", resourceType: "AWS::S3::Bucket", replacement: false, replacementMode: "False", details: ["Tags"] }]);
    },
    async executeChangeSet(args) {
      calls.push(`execute:${args.changeSetName}`);
      status = pending === "IMPORT" ? "IMPORT_COMPLETE" : "UPDATE_COMPLETE";
    },
    async deleteChangeSet(args) {
      calls.push(`delete:${args.changeSetName}`);
    },
    async waitForStack() {
      calls.push("waitForStack");
      return { stackStatus: status, outputs: {} };
    },
    async describeStack() {
      return { stackStatus: status, outputs: {} };
    },
    async rollbackStack() {},
  };
  if (opts.noImport) delete cfn.createImportChangeSet;
  return { cfn, calls, templates, imports };
}

const approveAll = (seen: Array<{ step: string; lines: string[] }> = []): CfnAdoptionReview => async (step, _cs, lines) => {
  seen.push({ step, lines });
  return true;
};

describe("planCfnAdoption (#4536)", () => {
  test("the IMPORT template drops the markers and the stack tags; the marker template keeps them", () => {
    const plan = planCfnAdoption({ template: template(), adoption: bucketOnly(), index: INDEX, manifest: MANIFEST });
    expect(plan.refusals).toEqual([]);
    expect(plan.resources).toEqual([
      {
        node: BUCKET,
        logicalId: "BucketWebLogs",
        type: "AWS::S3::Bucket",
        identifier: { BucketName: "web-logs" },
        deletionPolicy: "Retain",
        tagProperty: "Tags",
        markers: { "chant:managed-by": "chant", "chant:stack": "web", "chant:env": "prod" },
      },
    ]);
    expect(plan.importTemplate.Resources.BucketWebLogs!.Properties!.Tags).toEqual([{ Key: "team", Value: "shop" }]);
    expect(plan.importTemplate.Metadata).toBeUndefined();
    expect(plan.importTemplate.Resources.BucketWebLogs!.DeletionPolicy).toBe("Retain");
    expect(plan.markerTemplate).toEqual(template());
  });

  test("a tag list of markers only is dropped from the IMPORT template", () => {
    const t = template();
    t.Resources.BucketWebLogs!.Properties!.Tags = [...MARKERS];
    const plan = planCfnAdoption({ template: t, adoption: bucketOnly(), index: INDEX, manifest: MANIFEST });
    expect(plan.importTemplate.Resources.BucketWebLogs!.Properties!.Tags).toBeUndefined();
  });

  test("create-only tags are refused by name, never replaced to mark them", () => {
    const t = template();
    t.Resources.KeyPairDeploy = { Type: "AWS::EC2::KeyPair", DeletionPolicy: "Retain", Properties: { KeyName: "deploy" } };
    const plan = planCfnAdoption({
      template: t,
      adoption: adoption([{ node: BUCKET, as: "BucketWebLogs" }, { node: KEYPAIR, as: "KeyPairDeploy" }]),
      index: INDEX,
      manifest: MANIFEST,
    });
    expect(plan.refusals).toEqual(["KeyPairDeploy: AWS::EC2::KeyPair's tags can only be set at create, so writing chant's markers would replace it"]);
  });

  test("a resource with no DeletionPolicy, one already in the stack, and an extra resource are refused", () => {
    const t = template();
    delete t.Resources.BucketWebLogs!.DeletionPolicy;
    t.Resources.NewQueue = { Type: "AWS::SQS::Queue", Properties: {} };
    const plan = planCfnAdoption({ template: t, adoption: bucketOnly(), index: INDEX, manifest: MANIFEST, existing: new Set(["BucketWebLogs"]) });
    expect(plan.refusals.join("\n")).toMatch(/BucketWebLogs declares no DeletionPolicy/);
    expect(plan.refusals.join("\n")).toMatch(/BucketWebLogs is already in the stack/);
    expect(plan.refusals.join("\n")).toMatch(/the template also creates NewQueue/);
  });

  test("a stale adoption file, a missing logical id and a type mismatch are refused", () => {
    const stale = bucketOnly();
    stale.index = { ...stale.index, digest: "0".repeat(64), version: indexVersionName(INDEX.stamp.observedAt, "0".repeat(64)) };
    expect(planCfnAdoption({ template: template(), adoption: stale, index: INDEX, manifest: MANIFEST }).refusals.join("\n")).toMatch(/digest does not match/);
    const missing = adoption([{ node: BUCKET, as: "Elsewhere" }]);
    expect(planCfnAdoption({ template: template(), adoption: missing, index: INDEX, manifest: MANIFEST }).refusals.join("\n")).toMatch(/declares no resource Elsewhere/);
    const wrongType = adoption([{ node: BUCKET, as: "BucketWebLogs", type: "aws_s3_bucket" }]);
    expect(planCfnAdoption({ template: template(), adoption: wrongType, index: INDEX, manifest: MANIFEST }).refusals.join("\n")).toMatch(/names type aws_s3_bucket/);
  });

  test("a composite identifier splits on |", () => {
    expect(cfnResourceIdentifier(["RouteTableId", "DestinationCidrBlock"], "rtb-1|0.0.0.0/0")).toEqual({ RouteTableId: "rtb-1", DestinationCidrBlock: "0.0.0.0/0" });
    expect(cfnResourceIdentifier(["A", "B"], "only-one")).toBeUndefined();
  });

  test("the marker review lists each marker write as tags only", () => {
    const plan = planCfnAdoption({ template: template(), adoption: bucketOnly(), index: INDEX, manifest: MANIFEST });
    expect(cfnMarkerReview(plan)).toEqual(["marker write, tags only: BucketWebLogs (AWS::S3::Bucket) Tags += chant:env=prod, chant:managed-by=chant, chant:stack=web"]);
  });
});

describe("adoptIntoStack (#4536)", () => {
  test("IMPORT then the marker UPDATE, each reviewed before it executes", async () => {
    const fake = fakeCfn();
    const seen: Array<{ step: string; lines: string[] }> = [];
    const plan = planCfnAdoption({ template: template(), adoption: bucketOnly(), index: INDEX, manifest: MANIFEST });
    const out = await adoptIntoStack({ cfn: fake.cfn, stackName: "web", plan, review: approveAll(seen) });
    expect(out).toMatchObject({ status: "adopted", importChangeSet: "cs-import", markerChangeSet: "cs-markers" });
    expect(fake.calls).toEqual(["createImportChangeSet", "execute:cs-import", "waitForStack", "createChangeSet", "execute:cs-markers", "waitForStack"]);
    expect(fake.imports[0]!.resourcesToImport).toEqual([{ resourceType: "AWS::S3::Bucket", logicalResourceId: "BucketWebLogs", resourceIdentifier: { BucketName: "web-logs" } }]);
    expect(JSON.stringify(fake.templates.import)).not.toContain("chant:");
    expect(JSON.stringify(fake.templates.markers)).toContain("chant:managed-by");
    expect(seen.map((s) => s.step)).toEqual(["import", "markers"]);
    expect(seen[0]!.lines).toEqual(["import BucketWebLogs (AWS::S3::Bucket) BucketName=web-logs, DeletionPolicy Retain"]);
    expect(seen[1]!.lines[0]).toMatch(/^marker write, tags only: BucketWebLogs/);
  });

  test("a plan with refusals makes no change set", async () => {
    const fake = fakeCfn();
    const t = template();
    t.Resources.KeyPairDeploy = { Type: "AWS::EC2::KeyPair", DeletionPolicy: "Retain", Properties: { KeyName: "deploy" } };
    const plan = planCfnAdoption({ template: t, adoption: adoption([{ node: BUCKET, as: "BucketWebLogs" }, { node: KEYPAIR, as: "KeyPairDeploy" }]), index: INDEX, manifest: MANIFEST });
    const out = await adoptIntoStack({ cfn: fake.cfn, stackName: "web", plan, review: approveAll() });
    expect(out.status).toBe("refused");
    expect(fake.calls).toEqual([]);
  });

  test("a declined import review deletes the change set and executes nothing", async () => {
    const fake = fakeCfn();
    const plan = planCfnAdoption({ template: template(), adoption: bucketOnly(), index: INDEX, manifest: MANIFEST });
    const out = await adoptIntoStack({ cfn: fake.cfn, stackName: "web", plan, review: async () => false });
    expect(out).toEqual({ status: "declined", step: "import" });
    expect(fake.calls).toEqual(["createImportChangeSet", "delete:cs-import"]);
  });

  test("an IMPORT change set that would touch another resource is refused and deleted", async () => {
    const fake = fakeCfn({
      importChanges: [
        { action: "Import", logicalResourceId: "BucketWebLogs", resourceType: "AWS::S3::Bucket", replacement: false },
        { action: "Add", logicalResourceId: "Other", resourceType: "AWS::SQS::Queue", replacement: false },
      ],
    });
    const plan = planCfnAdoption({ template: template(), adoption: bucketOnly(), index: INDEX, manifest: MANIFEST });
    const out = await adoptIntoStack({ cfn: fake.cfn, stackName: "web", plan, review: approveAll() });
    expect(out).toMatchObject({ status: "refused", step: "import" });
    expect(fake.calls).toEqual(["createImportChangeSet", "delete:cs-import"]);
  });

  test("a marker UPDATE that changes more than tags, or replaces, is refused before it executes", async () => {
    for (const change of [
      { action: "Modify" as const, logicalResourceId: "BucketWebLogs", resourceType: "AWS::S3::Bucket", replacement: false, details: ["Tags", "VersioningConfiguration"] },
      { action: "Modify" as const, logicalResourceId: "BucketWebLogs", resourceType: "AWS::S3::Bucket", replacement: true, replacementMode: "True" as const, details: ["Tags"] },
      { action: "Add" as const, logicalResourceId: "Other", resourceType: "AWS::SQS::Queue", replacement: false },
    ]) {
      const fake = fakeCfn({ markerChanges: [change] });
      const plan = planCfnAdoption({ template: template(), adoption: bucketOnly(), index: INDEX, manifest: MANIFEST });
      const out = await adoptIntoStack({ cfn: fake.cfn, stackName: "web", plan, review: approveAll() });
      expect(out).toMatchObject({ status: "refused", step: "markers" });
      expect(fake.calls.slice(-2)).toEqual(["createChangeSet", "delete:cs-markers"]);
      expect(fake.calls).not.toContain("execute:cs-markers");
    }
  });

  test("a marker UPDATE with nothing to change ends the adoption without executing it", async () => {
    const fake = fakeCfn({ markerNoop: true });
    const plan = planCfnAdoption({ template: template(), adoption: bucketOnly(), index: INDEX, manifest: MANIFEST });
    const out = await adoptIntoStack({ cfn: fake.cfn, stackName: "web", plan, review: approveAll() });
    expect(out).toMatchObject({ status: "adopted", importChangeSet: "cs-import" });
    expect(fake.calls).toEqual(["createImportChangeSet", "execute:cs-import", "waitForStack", "createChangeSet", "delete:cs-markers"]);
  });

  test("a client that cannot create an IMPORT change set is refused", async () => {
    const fake = fakeCfn({ noImport: true });
    const plan = planCfnAdoption({ template: template(), adoption: bucketOnly(), index: INDEX, manifest: MANIFEST });
    expect(await adoptIntoStack({ cfn: fake.cfn, stackName: "web", plan, review: approveAll() })).toMatchObject({ status: "refused", step: "plan" });
  });

  test("markerChangeSetProblems accepts a tags-only Modify on an imported resource", () => {
    const plan = planCfnAdoption({ template: template(), adoption: bucketOnly(), index: INDEX, manifest: MANIFEST });
    const cs: CfnChangeSet = { changeSetName: "x", stackName: "web", status: "CREATE_COMPLETE", isCreate: false, changes: [{ action: "Modify", logicalResourceId: "BucketWebLogs", resourceType: "AWS::S3::Bucket", replacement: false, details: ["Tags"] }] };
    expect(markerChangeSetProblems(cs, plan)).toEqual([]);
  });
});
