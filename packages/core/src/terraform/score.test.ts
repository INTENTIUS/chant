import { describe, test, expect } from "vitest";
import { buildFixtureGraph } from "./__fixtures__/build-graph";
import { scoreEstate, bandFor } from "./score";
import type { Hcl2JsonTree } from "./types";

const byAddress = (results: ReturnType<typeof scoreEstate>) =>
  Object.fromEntries(results.map((r) => [r.address, r]));

describe("scoreEstate — #197 worked examples", () => {
  test("clean leaf: aws_s3_bucket.assets ≈ 88 (versioning folded, 1 inbound from Lambda)", () => {
    const tree: Hcl2JsonTree = {
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
    const results = scoreEstate(buildFixtureGraph(tree));
    const map = byAddress(results);

    // The folded sub-resource is not ranked on its own.
    expect(map["aws_s3_bucket_versioning.assets"]).toBeUndefined();

    const bucket = map["aws_s3_bucket.assets"];
    expect(bucket.score).toBe(88); // 100 - 12*1(inbound) ; versioning edge discounted
    expect(bucket.band).toBe("clean leaf");
    expect(bucket.mapsTo).toBe("AWS::S3::Bucket");
    expect(bucket.breakdown.inbound).toBe(1);
  });

  test("carvable w/ edits: module.cdn ≈ 61 (2 inbound, tier-2 composite map)", () => {
    const tree: Hcl2JsonTree = {
      module: { cdn: [{ source: "./cdn" }] },
      resource: {
        aws_route53_record: {
          www: [{ name: "${module.cdn.domain}" }],
          apex: [{ name: "${module.cdn.domain}" }],
        },
      },
    };
    const results = scoreEstate(buildFixtureGraph(tree));
    const cdn = byAddress(results)["module.cdn"];
    expect(cdn.score).toBe(61); // 100 - 12*2 - 15*(2-1)
    expect(cdn.band).toBe("carvable w/ edits");
    expect(cdn.breakdown.inbound).toBe(2);
    expect(cdn.breakdown.tier).toBe(2);
  });

  test("leave in Terraform: aws_vpc.main with 40 inbound → clamped to 0", () => {
    const consumers: Record<string, unknown[]> = {};
    for (let i = 0; i < 40; i++) {
      consumers[`s${i}`] = [{ vpc_id: "${aws_vpc.main.id}" }];
    }
    const tree: Hcl2JsonTree = {
      resource: {
        aws_vpc: { main: [{ cidr_block: "10.0.0.0/16" }] },
        aws_subnet: consumers,
      },
    };
    const vpc = byAddress(scoreEstate(buildFixtureGraph(tree)))["aws_vpc.main"];
    expect(vpc.score).toBe(0);
    expect(vpc.band).toBe("leave in Terraform");
    expect(vpc.breakdown.inbound).toBe(40);
  });
});

describe("scoreEstate — penalties", () => {
  test("unsupported provider/type scores 0 regardless of edges", () => {
    const tree: Hcl2JsonTree = {
      resource: { random_pet: { name: [{ length: 2 }] } },
    };
    const r = scoreEstate(buildFixtureGraph(tree))[0];
    expect(r.score).toBe(0);
    expect(r.breakdown.tier).toBeNull();
    expect(r.mapsTo).toBeUndefined();
  });

  test("count/for_each applies the dynamic penalty", () => {
    const tree: Hcl2JsonTree = {
      resource: {
        aws_sqs_queue: {
          plain: [{ name: "q" }],
          fanned: [{ count: 3, name: "q" }],
        },
      },
    };
    const map = byAddress(scoreEstate(buildFixtureGraph(tree)));
    expect(map["aws_sqs_queue.plain"].score).toBe(100); // tier1, no edges, no dynamic
    expect(map["aws_sqs_queue.fanned"].score).toBe(90); // -10 dynamic
  });

  test("outbound dependency costs less than inbound", () => {
    // A tier-1 leaf that depends on one survivor: -4 outbound.
    const tree: Hcl2JsonTree = {
      resource: {
        aws_sns_topic: { alerts: [{ name: "a" }] },
        aws_sqs_queue: { dlq: [{ name: "d", redrive: "${aws_sns_topic.alerts.arn}" }] },
      },
    };
    const map = byAddress(scoreEstate(buildFixtureGraph(tree)));
    expect(map["aws_sqs_queue.dlq"].score).toBe(96); // 100 - 4*1 outbound
    expect(map["aws_sns_topic.alerts"].score).toBe(88); // 100 - 12*1 inbound
  });

  test("an output block reading a resource costs 4, not 12 (#1638)", () => {
    const tree: Hcl2JsonTree = {
      resource: { aws_s3_bucket: { assets: [{ bucket: "b" }] } },
      output: { assets_bucket: [{ value: "${aws_s3_bucket.assets.bucket}" }] },
    };
    const bucket = byAddress(scoreEstate(buildFixtureGraph(tree)))["aws_s3_bucket.assets"];
    expect(bucket.score).toBe(96); // 100 - 4*1 output
    expect(bucket.breakdown.outputs).toBe(1);
    expect(bucket.breakdown.inbound).toBe(0); // not counted as a data-source patch
    expect(bucket.breakdown.penalties.outputs).toBe(-4);
  });

  test("an output and a resource reference are counted apart", () => {
    const tree: Hcl2JsonTree = {
      resource: {
        aws_s3_bucket: { assets: [{ bucket: "b" }] },
        aws_lambda_function: { api: [{ environment: { variables: { B: "${aws_s3_bucket.assets.bucket}" } } }] },
      },
      output: { assets_arn: [{ value: "${aws_s3_bucket.assets.arn}" }] },
    };
    const bucket = byAddress(scoreEstate(buildFixtureGraph(tree)))["aws_s3_bucket.assets"];
    expect(bucket.breakdown).toMatchObject({ inbound: 1, outputs: 1 });
    expect(bucket.score).toBe(84); // 100 - 12 - 4
  });

  test("results are ranked most-peelable first", () => {
    const tree: Hcl2JsonTree = {
      resource: {
        aws_vpc: { main: [{ cidr_block: "10.0.0.0/16" }] },
        aws_sqs_queue: { q: [{ name: "q", vpc: "${aws_vpc.main.id}" }] },
        aws_sns_topic: { t: [{ name: "t" }] },
      },
    };
    const scores = scoreEstate(buildFixtureGraph(tree)).map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});

describe("bandFor", () => {
  test("band boundaries", () => {
    expect(bandFor(100)).toBe("clean leaf");
    expect(bandFor(80)).toBe("clean leaf");
    expect(bandFor(79)).toBe("carvable w/ edits");
    expect(bandFor(50)).toBe("carvable w/ edits");
    expect(bandFor(49)).toBe("leave in Terraform");
    expect(bandFor(0)).toBe("leave in Terraform");
  });
});
