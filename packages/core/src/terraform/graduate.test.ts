import { describe, test, expect } from "vitest";
import { buildGraph } from "./graph";
import { boundaryReport } from "./carve";
import { graduationPlan, DEFAULT_TAG_OWNERSHIP_KEYS } from "./graduate";
import type { Hcl2JsonTree } from "./types";

const bucketTree: Hcl2JsonTree = {
  resource: {
    aws_s3_bucket: { assets: [{ bucket: "myapp-assets-prod" }] },
    aws_lambda_function: { api: [{ x: "${aws_s3_bucket.assets.arn}" }] },
  },
};

describe("graduationPlan", () => {
  test("resolves the ownership marker + tags (chant-owned)", () => {
    const report = boundaryReport(buildGraph(bucketTree), "aws_s3_bucket.assets")!;
    const plan = graduationPlan(report, { stack: "assets", env: "prod" });

    expect(plan.marker).toEqual({ stack: "assets", env: "prod" });
    expect(plan.ownershipTags).toEqual({
      [DEFAULT_TAG_OWNERSHIP_KEYS.managedBy]: "chant",
      [DEFAULT_TAG_OWNERSHIP_KEYS.stack]: "assets",
      [DEFAULT_TAG_OWNERSHIP_KEYS.env]: "prod",
    });
  });

  test("stack defaults to the resource's local name", () => {
    const report = boundaryReport(buildGraph(bucketTree), "aws_s3_bucket.assets")!;
    const plan = graduationPlan(report);
    expect(plan.marker.stack).toBe("assets");
    expect(plan.ownershipTags).not.toHaveProperty(DEFAULT_TAG_OWNERSHIP_KEYS.env); // no env → omitted
  });

  test("runbook is reversible and BYOL (import rollback, no chant-runs-apply)", () => {
    const report = boundaryReport(buildGraph(bucketTree), "aws_s3_bucket.assets")!;
    const plan = graduationPlan(report, { env: "prod" });
    const runbook = plan.steps.join("\n");
    expect(runbook).toMatch(/terraform import aws_s3_bucket\.assets/);
    expect(runbook).toMatch(/cloudformation deploy|ApplyOp/);
    expect(runbook).toMatch(/lifecycle diff --live/);
  });

  test("warns when outbound edges leave deferred inputs to wire", () => {
    // Carve the Lambda: it depends on the bucket (survivor) → outbound/deferred.
    const report = boundaryReport(buildGraph(bucketTree), "aws_lambda_function.api")!;
    const plan = graduationPlan(report, { env: "prod" });
    expect(plan.warnings.join(" ")).toMatch(/deferred deploy-time input/i);
  });
});
