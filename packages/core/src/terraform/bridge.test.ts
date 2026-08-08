import { describe, test, expect } from "vitest";
import { buildFixtureGraph } from "./__fixtures__/build-graph";
import { boundaryReport } from "./carve";
import { generateBridge, type CarvedIdentity } from "./bridge";
import type { Hcl2JsonTree } from "./types";

const workedExample: Hcl2JsonTree = {
  resource: {
    aws_s3_bucket: { assets: [{ bucket: "myapp-assets-prod" }] },
    aws_lambda_function: {
      api: [
        {
          function_name: "myapp-api",
          environment: {
            variables: {
              ASSETS_BUCKET: "${aws_s3_bucket.assets.bucket}",
              ASSETS_ARN: "${aws_s3_bucket.assets.arn}",
            },
          },
        },
      ],
    },
  },
};

// The original surviving Terraform text (bare HCL references, as authored).
const API_TF = `resource "aws_lambda_function" "api" {
  function_name = "myapp-api"
  environment {
    variables = {
      ASSETS_BUCKET = aws_s3_bucket.assets.bucket
      ASSETS_ARN    = aws_s3_bucket.assets.arn
    }
  }
}
`;

const identities = new Map<string, CarvedIdentity>([
  ["aws_s3_bucket.assets", { attr: "bucket", value: "myapp-assets-prod" }],
]);

describe("generateBridge — inbound (data-source rewrite)", () => {
  test("adds a data source for the carved bucket", () => {
    const report = boundaryReport(buildFixtureGraph(workedExample), "aws_s3_bucket.assets")!;
    const plan = generateBridge(report, [{ path: "api.tf", content: API_TF }], identities);

    expect(plan.dataSources).toHaveLength(1);
    expect(plan.dataSources[0]).toMatchObject({ address: "aws_s3_bucket.assets", type: "aws_s3_bucket", name: "assets" });
    expect(plan.dataSources[0].hcl).toBe(
      'data "aws_s3_bucket" "assets" {\n  bucket = "myapp-assets-prod"\n}',
    );
  });

  test("rewrites survivor references to the data source", () => {
    const report = boundaryReport(buildFixtureGraph(workedExample), "aws_s3_bucket.assets")!;
    const plan = generateBridge(report, [{ path: "api.tf", content: API_TF }], identities);

    const rewrite = plan.rewrites.find((r) => r.path === "api.tf")!;
    expect(rewrite.changed).toBe(true);
    expect(rewrite.rewritten).toContain("data.aws_s3_bucket.assets.bucket");
    expect(rewrite.rewritten).toContain("data.aws_s3_bucket.assets.arn");
    // The bare references are gone.
    expect(rewrite.rewritten).not.toMatch(/(?<!data\.)\baws_s3_bucket\.assets\.bucket/);
  });

  test("does not double-prefix an already-rewritten reference (idempotent)", () => {
    const report = boundaryReport(buildFixtureGraph(workedExample), "aws_s3_bucket.assets")!;
    const already = API_TF.replace(/aws_s3_bucket\.assets/g, "data.aws_s3_bucket.assets");
    const plan = generateBridge(report, [{ path: "api.tf", content: already }], identities);
    const rewrite = plan.rewrites.find((r) => r.path === "api.tf")!;
    expect(rewrite.changed).toBe(false);
    expect(rewrite.rewritten).not.toContain("data.data.aws_s3_bucket");
  });

  test("does not touch the carved resource's own declaration (quoted labels)", () => {
    const report = boundaryReport(buildFixtureGraph(workedExample), "aws_s3_bucket.assets")!;
    const decl = `resource "aws_s3_bucket" "assets" {\n  bucket = "myapp-assets-prod"\n}\n`;
    const plan = generateBridge(report, [{ path: "bucket.tf", content: decl }], identities);
    const rewrite = plan.rewrites.find((r) => r.path === "bucket.tf")!;
    // `resource "aws_s3_bucket" "assets"` uses quoted labels, not the dotted
    // token, so it is left alone.
    expect(rewrite.rewritten).toContain('resource "aws_s3_bucket" "assets"');
    expect(rewrite.changed).toBe(false);
  });

  test("unknown identity emits a TODO data source instead of a wrong value", () => {
    const report = boundaryReport(buildFixtureGraph(workedExample), "aws_s3_bucket.assets")!;
    const plan = generateBridge(report, [{ path: "api.tf", content: API_TF }], new Map());
    expect(plan.dataSources[0].hcl).toContain("# TODO");
  });
});

describe("generateBridge — outbound (deferred inputs)", () => {
  test("records outbound edges as deferred deploy-time inputs", () => {
    const tree: Hcl2JsonTree = {
      resource: {
        aws_sns_topic: { alerts: [{ name: "a" }] },
        aws_sqs_queue: { dlq: [{ name: "d", redrive: "${aws_sns_topic.alerts.arn}" }] },
      },
    };
    const report = boundaryReport(buildFixtureGraph(tree), "aws_sqs_queue.dlq")!;
    const plan = generateBridge(report, [], new Map());
    expect(plan.dataSources).toEqual([]); // no inbound → no survivor patch
    expect(plan.deferredInputs).toHaveLength(1);
    expect(plan.deferredInputs[0]).toMatchObject({ survivor: "aws_sns_topic.alerts", carved: "aws_sqs_queue.dlq" });
    // The deferred input names the build param emit declares for it (#998).
    expect(plan.deferredInputs[0].params).toEqual(["redrive"]);
    expect(plan.deferredInputs[0].note).toContain("build param `redrive`");
    expect(plan.deferredInputs[0].note).toContain("--param");
  });
});

describe("generateBridge — runbook", () => {
  test("is reversible and observe-first, with the state-rm and import steps", () => {
    const report = boundaryReport(buildFixtureGraph(workedExample), "aws_s3_bucket.assets")!;
    const plan = generateBridge(report, [{ path: "api.tf", content: API_TF }], identities);
    expect(plan.runbook).toContain("terraform state rm aws_s3_bucket.assets");
    expect(plan.runbook).toContain("does NOT destroy");
    expect(plan.runbook).toContain("terraform import aws_s3_bucket.assets");
    expect(plan.runbook).toMatch(/reversible/i);
  });
});
