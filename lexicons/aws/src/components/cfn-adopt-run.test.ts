/**
 * #4537: `cfn-deploy` under `run --components <name> --adopt <file>`, over a
 * fake CloudFormation client. The step plans the adoption against its built
 * template and the stack's resources, sends each change set through the
 * review core hands it, refuses what the library refuses before any change
 * set exists, and says what to do when the marker step stops after a good
 * import. Nothing reaches a cloud; the floci run is a maintainer run.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AdoptionReviewRequest, DeployAdoption } from "@intentius/chant/components/adoption";
import type { DeployContext } from "@intentius/chant/components/capability";
import { indexDocumentDigest, indexScopeKey, indexVersionName, type CloudIndexScope, type IndexDocument } from "@intentius/chant/lifecycle/index-document";
import type { ImportabilityManifestEntry } from "../importable";
import { createCfnDeployCapability } from "./apply";
import { runCfnAdoption } from "./cfn-adopt-run";
import type { CfnChange, CfnChangeSet, CloudExecutor, CloudFormationClient } from "./cloud-executor";

const SCOPE: CloudIndexScope = { kind: "cloud", substrate: "aws", scopeId: "000000000000", locations: ["us-east-1"], types: "*" };
const BUCKET = "aws/000000000000/us-east-1/AWS::S3::Bucket/web-logs";
const graph = {
  version: 1 as const,
  nodes: [{ id: BUCKET, kind: "AWS::S3::Bucket", lexicon: "aws", attrs: { BucketName: "web-logs" }, listedType: "AWS::S3::Bucket", location: "us-east-1", nativeId: "web-logs" }],
  edges: [],
  groups: {},
};
const INDEX: IndexDocument = {
  index: "v1",
  stamp: { source: { kind: "cloud", name: "behold-lister" }, scope: SCOPE, scopeKey: indexScopeKey(SCOPE), observedAt: "2026-10-26T12:00:00Z", digest: indexDocumentDigest({ graph, coverage: [] }) },
  coverage: [],
  graph,
};
const MANIFEST = new Map<string, ImportabilityManifestEntry>([
  [
    "AWS::S3::Bucket",
    {
      resourceType: "AWS::S3::Bucket",
      kind: "resource",
      handlers: ["create", "delete", "list", "read", "update"],
      primaryIdentifier: ["BucketName"],
      tagging: { taggable: true, tagUpdatable: true, tagProperty: "Tags", tagShape: "list" },
    },
  ],
]);

function templateFile(extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "cfn-adopt-run-test-"));
  const path = join(dir, "web.template.json");
  writeFileSync(
    path,
    JSON.stringify({
      AWSTemplateFormatVersion: "2010-09-09",
      Metadata: { "chant:ownership": { "chant:managed-by": "chant", "chant:stack": "web", "chant:env": "prod" } },
      Resources: {
        BucketWebLogs: {
          Type: "AWS::S3::Bucket",
          DeletionPolicy: "Retain",
          UpdateReplacePolicy: "Retain",
          Properties: {
            BucketName: "web-logs",
            Tags: [
              { Key: "chant:managed-by", Value: "chant" },
              { Key: "chant:stack", Value: "web" },
              { Key: "chant:env", Value: "prod" },
            ],
          },
        },
        ...extra,
      },
    }),
  );
  return path;
}

function adoptionOf(seen: AdoptionReviewRequest[], answer: (r: AdoptionReviewRequest) => boolean = () => true): DeployAdoption {
  return {
    file: "adopt.json",
    adoption: {
      adopt: "v1",
      index: { scopeKey: INDEX.stamp.scopeKey, version: indexVersionName(INDEX.stamp.observedAt, INDEX.stamp.digest), digest: INDEX.stamp.digest },
      select: [{ node: BUCKET, as: "BucketWebLogs", type: "AWS::S3::Bucket" }],
    },
    index: INDEX,
    review: async (r) => {
      seen.push(r);
      return answer(r);
    },
  };
}

function fake(opts: { existing?: string[]; noList?: boolean; markerChanges?: CfnChange[] } = {}) {
  const calls: string[] = [];
  let status = "REVIEW_IN_PROGRESS";
  let pending: "IMPORT" | "UPDATE" | undefined;
  const cs = (name: string, changes: CfnChange[], extra: Partial<CfnChangeSet> = {}): CfnChangeSet => ({ changeSetName: name, stackName: "web", status: "CREATE_COMPLETE", isCreate: false, changes, ...extra });
  const cfn: CloudFormationClient = {
    async listStackResources() {
      calls.push("listStackResources");
      return opts.existing ?? [];
    },
    async createImportChangeSet(args) {
      calls.push("createImportChangeSet");
      expect(readFileSync(args.templatePath, "utf8")).not.toContain("chant:");
      pending = "IMPORT";
      return cs(
        "cs-import",
        args.resourcesToImport.map((r) => ({ action: "Import" as const, logicalResourceId: r.logicalResourceId, resourceType: r.resourceType, replacement: false })),
        { changeSetType: "IMPORT" },
      );
    },
    async createChangeSet() {
      calls.push("createChangeSet");
      pending = "UPDATE";
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
      return { stackStatus: status, outputs: {} };
    },
    async describeStack() {
      return { stackStatus: status, outputs: { BucketName: "web-logs" } };
    },
    async rollbackStack() {
      calls.push("rollbackStack");
    },
  };
  if (opts.noList) delete cfn.listStackResources;
  return { executor: { cloudformation: cfn } as unknown as CloudExecutor, calls };
}

const ctx = (adoption?: DeployAdoption): DeployContext => ({ env: "prod", component: "web", ...(adoption ? { adoption } : {}) });

describe("runCfnAdoption (#4537)", () => {
  test("IMPORT then the marker UPDATE, each through the review, and the outcome says what was adopted", async () => {
    const { executor, calls } = fake();
    const seen: AdoptionReviewRequest[] = [];
    const adoption = adoptionOf(seen);
    const out = await runCfnAdoption(executor, ctx(adoption), { stack: "web", template: templateFile() }, adoption, { manifest: MANIFEST });
    expect(out).toEqual({ stackStatus: "UPDATE_COMPLETE", outputs: { BucketName: "web-logs" } });
    expect(calls).toEqual(["listStackResources", "createImportChangeSet", "execute:cs-import", "createChangeSet", "execute:cs-markers"]);
    expect(seen.map((r) => [r.step, r.changeSet])).toEqual([
      ["import", "cs-import"],
      ["markers", "cs-markers"],
    ]);
    expect(seen[0]!.entries).toMatchObject([{ address: "BucketWebLogs", action: "no-op", importing: true }]);
    expect(seen[1]!.lines).toEqual(["marker write, tags only: BucketWebLogs (AWS::S3::Bucket) Tags += chant:env=prod, chant:managed-by=chant, chant:stack=web"]);
    expect(adoption.outcome).toMatchObject({ member: "web", status: "adopted" });
    expect(adoption.outcome!.lines[0]).toBe("imported BucketWebLogs (AWS::S3::Bucket) BucketName=web-logs, DeletionPolicy Retain");
  });

  test("a declined marker review after a good import says a plain deploy writes the markers", async () => {
    const { executor, calls } = fake();
    const adoption = adoptionOf([], (r) => r.step === "import");
    await expect(runCfnAdoption(executor, ctx(adoption), { stack: "web", template: templateFile() }, adoption, { manifest: MANIFEST })).rejects.toThrow(/declined at the markers step/);
    expect(calls).toEqual(["listStackResources", "createImportChangeSet", "execute:cs-import", "createChangeSet", "delete:cs-markers"]);
    expect(adoption.outcome).toMatchObject({ status: "declined", step: "markers" });
    expect(adoption.outcome!.lines.join("\n")).toMatch(
      /imported into web and carry no chant markers yet\. A plain deploy of the same template writes them: chant run --components web --env prod, without --adopt\./,
    );
  });

  test("a marker change set that is not tags only is refused, with the same way out", async () => {
    const { executor, calls } = fake({ markerChanges: [{ action: "Modify", logicalResourceId: "BucketWebLogs", resourceType: "AWS::S3::Bucket", replacement: false, details: ["Tags", "VersioningConfiguration"] }] });
    const adoption = adoptionOf([]);
    await expect(runCfnAdoption(executor, ctx(adoption), { stack: "web", template: templateFile() }, adoption, { manifest: MANIFEST })).rejects.toThrow(/refused at the markers step/);
    expect(calls.at(-1)).toBe("delete:cs-markers");
    expect(adoption.outcome!.lines.join("\n")).toMatch(/not only its tags/);
    expect(adoption.outcome!.lines.join("\n")).toMatch(/A plain deploy of the same template writes them/);
  });

  test("a declined IMPORT review imports nothing and deletes the change set", async () => {
    const { executor, calls } = fake();
    const adoption = adoptionOf([], () => false);
    await expect(runCfnAdoption(executor, ctx(adoption), { stack: "web", template: templateFile() }, adoption, { manifest: MANIFEST })).rejects.toThrow(/declined at the import step/);
    expect(calls).toEqual(["listStackResources", "createImportChangeSet", "delete:cs-import"]);
    expect(adoption.outcome!.lines).toContain("Nothing was imported.");
  });

  test("what the library refuses is refused before any change set: a resource already in the stack, an extra resource", async () => {
    const { executor, calls } = fake({ existing: ["BucketWebLogs"] });
    const adoption = adoptionOf([]);
    await expect(
      runCfnAdoption(executor, ctx(adoption), { stack: "web", template: templateFile({ NewQueue: { Type: "AWS::SQS::Queue", Properties: {} } }) }, adoption, { manifest: MANIFEST }),
    ).rejects.toThrow(/adoption refused/);
    expect(calls).toEqual(["listStackResources"]);
    expect(adoption.outcome).toMatchObject({ status: "refused", step: "plan" });
    const lines = adoption.outcome!.lines.join("\n");
    expect(lines).toMatch(/BucketWebLogs is already in the stack/);
    expect(lines).toMatch(/the template also creates NewQueue/);
  });

  test("a client that cannot list the stack's resources, and an unreadable template, are refused", async () => {
    const noList = fake({ noList: true });
    const a = adoptionOf([]);
    await expect(runCfnAdoption(noList.executor, ctx(a), { stack: "web", template: templateFile() }, a, { manifest: MANIFEST })).rejects.toThrow(/cannot list the stack's resources/);
    expect(noList.calls).toEqual([]);
    const archived = fake();
    const b = adoptionOf([]);
    await expect(runCfnAdoption(archived.executor, ctx(b), { stack: "web", template: "archive:web.template.json" }, b, { manifest: MANIFEST })).rejects.toThrow(/cannot be read here/);
    expect(archived.calls).toEqual([]);
  });

  test("an adoption already taken by another step is refused", async () => {
    const { executor, calls } = fake();
    const adoption = adoptionOf([]);
    adoption.outcome = { member: "other", status: "adopted", lines: [] };
    await expect(runCfnAdoption(executor, ctx(adoption), { stack: "web", template: templateFile() }, adoption, { manifest: MANIFEST })).rejects.toThrow(/already taken by other/);
    expect(calls).toEqual([]);
  });

  test("cfn-deploy's run takes DeployContext.adoption instead of a plain deploy", async () => {
    const { executor, calls } = fake({ existing: ["BucketWebLogs"] });
    const adoption = adoptionOf([]);
    const capability = createCfnDeployCapability(executor);
    await expect(capability.run(ctx(adoption), { stack: "web", template: templateFile() })).rejects.toThrow(/adoption refused/);
    expect(calls).toEqual(["listStackResources"]);
    expect(adoption.outcome).toMatchObject({ member: "web", status: "refused" });
  });
});
