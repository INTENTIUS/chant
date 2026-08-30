import { describe, test, expect } from "vitest";
import { buildFixtureGraph } from "./__fixtures__/build-graph";
import { boundaryReport } from "./carve";
import { graduationPlan, stampOwnershipIntoSource, DEFAULT_TAG_OWNERSHIP_KEYS } from "./graduate";
import { LABEL_OWNERSHIP_KEYS } from "../ownership";
import type { Hcl2JsonTree } from "./types";

const bucketTree: Hcl2JsonTree = {
  resource: {
    aws_s3_bucket: { assets: [{ bucket: "myapp-assets-prod" }] },
    aws_lambda_function: { api: [{ x: "${aws_s3_bucket.assets.arn}" }] },
  },
};

describe("graduationPlan", () => {
  test("resolves the ownership marker + tags (chant-owned)", () => {
    const report = boundaryReport(buildFixtureGraph(bucketTree), "aws_s3_bucket.assets")!;
    const plan = graduationPlan(report, { stack: "assets", env: "prod" });

    expect(plan.marker).toEqual({ stack: "assets", env: "prod" });
    expect(plan.ownershipTags).toEqual({
      [DEFAULT_TAG_OWNERSHIP_KEYS.managedBy]: "chant",
      [DEFAULT_TAG_OWNERSHIP_KEYS.stack]: "assets",
      [DEFAULT_TAG_OWNERSHIP_KEYS.env]: "prod",
    });
  });

  test("stack defaults to the resource's local name", () => {
    const report = boundaryReport(buildFixtureGraph(bucketTree), "aws_s3_bucket.assets")!;
    const plan = graduationPlan(report);
    expect(plan.marker.stack).toBe("assets");
    expect(plan.ownershipTags).not.toHaveProperty(DEFAULT_TAG_OWNERSHIP_KEYS.env); // no env → omitted
  });

  test("runbook is reversible and BYOL (import rollback, no chant-runs-apply)", () => {
    const report = boundaryReport(buildFixtureGraph(bucketTree), "aws_s3_bucket.assets")!;
    const plan = graduationPlan(report, { env: "prod" });
    const runbook = plan.steps.join("\n");
    expect(runbook).toMatch(/terraform import aws_s3_bucket\.assets/);
    expect(runbook).toMatch(/cloudformation deploy|ApplyOp/);
    expect(runbook).toMatch(/lifecycle diff --live/);
  });

  test("a k8s carve graduates in labels and kubectl, not tags and CloudFormation (#999)", () => {
    const report = boundaryReport(buildFixtureGraph(bucketTree), "aws_s3_bucket.assets")!;
    const plan = graduationPlan(report, { stack: "assets", env: "prod", lexicon: "k8s" });

    // The channel the k8s serializer actually merges in, not the AWS tag keys.
    expect(plan.markerKind).toBe("labels");
    expect(plan.ownershipTags).toEqual({
      [LABEL_OWNERSHIP_KEYS.managedBy]: "chant",
      [LABEL_OWNERSHIP_KEYS.stack]: "assets",
      [LABEL_OWNERSHIP_KEYS.env]: "prod",
    });
    const runbook = plan.steps.join("\n");
    expect(runbook).toContain("kubectl apply -f");
    expect(runbook).toContain("--lexicon k8s");
    expect(runbook).not.toContain("cloudformation deploy");
  });

  test("warns when outbound edges leave deferred inputs to wire", () => {
    // Carve the Lambda: it depends on the bucket (survivor) → outbound/deferred.
    const report = boundaryReport(buildFixtureGraph(bucketTree), "aws_lambda_function.api")!;
    const plan = graduationPlan(report, { env: "prod" });
    expect(plan.warnings.join(" ")).toMatch(/deferred deploy-time input/i);
  });
});

const TAGS = { "chant:managed-by": "chant", "chant:stack": "assets", "chant:env": "prod" };

describe("stampOwnershipIntoSource", () => {
  test("merges into an existing Tags prop, replacing stale chant keys", () => {
    const src = [
      'import { Bucket } from "@intentius/chant-lexicon-aws";',
      "",
      "export const assets = new Bucket({",
      '  BucketName: "myapp-assets-prod",',
      '  Tags: [{"Key":"Team","Value":"web"},{"Key":"chant:stack","Value":"old"}],',
      "});",
      "",
    ].join("\n");

    const res = stampOwnershipIntoSource(src, TAGS)!;
    expect(res.changed).toBe(true);
    const tagsLine = res.content.split("\n").find((l) => l.includes("Tags:"))!;
    const tags = JSON.parse(tagsLine.trim().replace(/^Tags: /, "").replace(/,$/, "")) as Array<{ Key: string; Value: string }>;
    expect(tags).toEqual([
      { Key: "Team", Value: "web" },
      { Key: "chant:managed-by", Value: "chant" },
      { Key: "chant:stack", Value: "assets" },
      { Key: "chant:env", Value: "prod" },
    ]);
  });

  test("inserts a Tags prop when the constructor has none (unmapped comment untouched)", () => {
    const src = [
      "export const api = new LogGroup({",
      '  LogGroupName: "/myapp/api",',
      "});",
      "",
      "/* Unmapped Terraform attributes (reconcile to native props before building):",
      '{ "skip_destroy": false }',
      "*/",
      "",
    ].join("\n");

    const res = stampOwnershipIntoSource(src, TAGS)!;
    expect(res.changed).toBe(true);
    const lines = res.content.split("\n");
    expect(lines[2]).toBe(`  Tags: ${JSON.stringify(Object.entries(TAGS).map(([Key, Value]) => ({ Key, Value })))},`);
    expect(lines[3]).toBe("});");
    expect(res.content).toContain("skip_destroy"); // the comment survives
  });

  test("handles an empty props object", () => {
    const src = "export const igw = new InternetGateway({});\n";
    const res = stampOwnershipIntoSource(src, TAGS)!;
    expect(res.changed).toBe(true);
    expect(res.content).toContain("new InternetGateway({\n  Tags: [");
    expect(res.content).toMatch(/\}\);\n$/);
  });

  test("is idempotent: a second stamp changes nothing", () => {
    const src = 'export const assets = new Bucket({\n  BucketName: "b",\n});\n';
    const first = stampOwnershipIntoSource(src, TAGS)!;
    const second = stampOwnershipIntoSource(first.content, TAGS)!;
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });

  test("returns null when there is no constructor to stamp", () => {
    expect(stampOwnershipIntoSource("// nothing here\n", TAGS)).toBeNull();
  });

  test("refuses a carved manifest rather than inventing a top-level Tags field (#999)", () => {
    // The props of a `k8sManifest` call ARE the object. A `Tags: [...]` line
    // spliced before the closing `});` would be a field the API server never
    // heard of, applied as if an author had written it.
    const src = [
      'import { k8sManifest } from "@intentius/chant-lexicon-k8s";',
      "",
      "export const app_config = k8sManifest({",
      '  apiVersion: "v1",',
      '  kind: "ConfigMap",',
      "  metadata: {",
      '    name: "app-config",',
      "  },",
      "});",
      "",
    ].join("\n");
    expect(stampOwnershipIntoSource(src, TAGS)).toBeNull();
  });
});
