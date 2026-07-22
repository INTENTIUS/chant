import { describe, test, expect } from "vitest";
import { buildGraph } from "./graph";
import { resolveCarveSet, boundaryReport } from "./carve";
import type { Hcl2JsonTree } from "./types";

// #197 worked example: a bucket a Lambda reads, with a versioning sub-resource.
const workedExample: Hcl2JsonTree = {
  resource: {
    aws_s3_bucket: { assets: [{ bucket: "myapp-assets-prod" }] },
    aws_s3_bucket_versioning: {
      assets: [{ bucket: "${aws_s3_bucket.assets.id}", versioning_configuration: { status: "Enabled" } }],
    },
    aws_lambda_function: {
      api: [
        {
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

describe("resolveCarveSet", () => {
  test("selected node plus its folded sub-resources", () => {
    const set = resolveCarveSet(buildGraph(workedExample), "aws_s3_bucket.assets");
    expect(set.map((m) => m.address).sort()).toEqual([
      "aws_s3_bucket.assets",
      "aws_s3_bucket_versioning.assets",
    ]);
    const folded = set.find((m) => m.address === "aws_s3_bucket_versioning.assets");
    expect(folded?.foldedInto).toBe("aws_s3_bucket.assets");
  });

  test("empty for an unknown address", () => {
    expect(resolveCarveSet(buildGraph(workedExample), "aws_s3_bucket.nope")).toEqual([]);
  });
});

describe("boundaryReport", () => {
  test("classifies the Lambda inbound edge; folds the versioning internal edge away", () => {
    const report = boundaryReport(buildGraph(workedExample), "aws_s3_bucket.assets")!;
    expect(report.target).toBe("aws_s3_bucket.assets");
    expect(report.peelability).toBe(88);
    expect(report.reversible).toBe(true);

    // The only boundary edge is the Lambda → bucket inbound; the versioning →
    // bucket edge is internal to the carve set and dropped.
    expect(report.inbound).toEqual([
      {
        direction: "inbound",
        survivor: "aws_lambda_function.api",
        carved: "aws_s3_bucket.assets",
        attrs: ["arn", "bucket"],
        bridge: "tf-data-source",
        required: "immediately",
      },
    ]);
    expect(report.outbound).toEqual([]);
  });

  test("outbound edges become deferred inputs", () => {
    const tree: Hcl2JsonTree = {
      resource: {
        aws_sns_topic: { alerts: [{ name: "a" }] },
        aws_sqs_queue: { dlq: [{ name: "d", redrive: "${aws_sns_topic.alerts.arn}" }] },
      },
    };
    // Carve the queue: it depends on the topic (a survivor) → outbound/deferred.
    const report = boundaryReport(buildGraph(tree), "aws_sqs_queue.dlq")!;
    expect(report.inbound).toEqual([]);
    expect(report.outbound).toEqual([
      {
        direction: "outbound",
        survivor: "aws_sns_topic.alerts",
        carved: "aws_sqs_queue.dlq",
        attrs: ["arn"],
        bridge: "deferred-input",
        required: "at-apply",
      },
    ]);
  });

  test("unsupported type is flagged in diagnostics", () => {
    const tree: Hcl2JsonTree = { resource: { random_pet: { n: [{ length: 2 }] } } };
    const report = boundaryReport(buildGraph(tree), "random_pet.n")!;
    expect(report.diagnostics.join(" ")).toMatch(/no known native mapping/i);
  });

  test("null for an unknown target", () => {
    expect(boundaryReport(buildGraph(workedExample), "aws_s3_bucket.nope")).toBeNull();
  });
});
