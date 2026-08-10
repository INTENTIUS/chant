import { describe, test, expect } from "vitest";
import { inboundEdges, outboundEdges, refFromAccessor } from "./graph";
import { buildFixtureGraph } from "./__fixtures__/build-graph";
import type { Hcl2JsonTree } from "./types";

/**
 * The #197 worked example, in the JSON shape `@cdktf/hcl2json` emits: a bucket,
 * its versioning sub-resource, and a Lambda that reads the bucket's name + arn.
 */
const workedExample: Hcl2JsonTree = {
  resource: {
    aws_s3_bucket: {
      assets: [{ bucket: "myapp-assets-prod", tags: { Team: "web", Env: "prod" } }],
    },
    aws_s3_bucket_versioning: {
      assets: [
        {
          bucket: "${aws_s3_bucket.assets.id}",
          versioning_configuration: { status: "Enabled" },
        },
      ],
    },
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

describe("buildGraph", () => {
  test("extracts resource nodes with addresses", () => {
    const g = buildFixtureGraph(workedExample);
    expect(g.nodes.map((n) => n.address)).toEqual([
      "aws_lambda_function.api",
      "aws_s3_bucket.assets",
      "aws_s3_bucket_versioning.assets",
    ]);
    expect(g.nodes.every((n) => n.kind === "resource")).toBe(true);
  });

  test("records directed edges with referenced attributes, deduped per target", () => {
    const g = buildFixtureGraph(workedExample);
    // versioning → bucket (.id), lambda → bucket (.bucket, .arn)
    expect(g.edges).toEqual([
      { from: "aws_lambda_function.api", to: "aws_s3_bucket.assets", attrs: ["arn", "bucket"], via: ["environment"] },
      { from: "aws_s3_bucket_versioning.assets", to: "aws_s3_bucket.assets", attrs: ["id"], via: ["bucket"] },
    ]);
  });

  test("inbound/outbound classification", () => {
    const g = buildFixtureGraph(workedExample);
    // Two survivors depend on the bucket; the bucket depends on nothing.
    expect(inboundEdges(g, "aws_s3_bucket.assets").map((e) => e.from)).toEqual([
      "aws_lambda_function.api",
      "aws_s3_bucket_versioning.assets",
    ]);
    expect(outboundEdges(g, "aws_s3_bucket.assets")).toEqual([]);
    // The Lambda depends on the bucket (outbound) and nothing depends on it.
    expect(outboundEdges(g, "aws_lambda_function.api").map((e) => e.to)).toEqual([
      "aws_s3_bucket.assets",
    ]);
    expect(inboundEdges(g, "aws_lambda_function.api")).toEqual([]);
  });

  test("module blocks become nodes and are referenceable", () => {
    const tree: Hcl2JsonTree = {
      module: { cdn: [{ source: "./cdn", bucket_arn: "${aws_s3_bucket.assets.arn}" }] },
      resource: {
        aws_s3_bucket: { assets: [{ bucket: "x" }] },
        aws_route53_record: { cdn: [{ name: "${module.cdn.domain}" }] },
      },
    };
    const g = buildFixtureGraph(tree);
    const cdn = g.nodes.find((n) => n.address === "module.cdn");
    expect(cdn).toMatchObject({ kind: "module", name: "cdn" });
    // module → bucket, and record → module
    expect(g.edges).toContainEqual({
      from: "module.cdn",
      to: "aws_s3_bucket.assets",
      attrs: ["arn"],
      via: ["bucket_arn"],
    });
    expect(g.edges).toContainEqual({
      from: "aws_route53_record.cdn",
      to: "module.cdn",
      attrs: ["domain"],
      via: ["name"],
    });
  });

  test("count / for_each mark a node dynamic (single instance until state resolves)", () => {
    const tree: Hcl2JsonTree = {
      resource: {
        aws_instance: {
          web: [{ count: 3, ami: "ami-123" }],
          worker: [{ for_each: "${var.workers}", ami: "ami-456" }],
          bastion: [{ ami: "ami-789" }],
        },
      },
    };
    const g = buildFixtureGraph(tree);
    const byAddr = Object.fromEntries(g.nodes.map((n) => [n.address, n]));
    expect(byAddr["aws_instance.web"]).toMatchObject({ hasDynamic: true, instances: 1 });
    expect(byAddr["aws_instance.worker"]).toMatchObject({ hasDynamic: true, instances: 1 });
    expect(byAddr["aws_instance.bastion"]).toMatchObject({ hasDynamic: false, instances: 1 });
  });

  test("a reference to a data source marks the referrer dynamic but is not an edge", () => {
    const tree: Hcl2JsonTree = {
      data: { aws_ami: { ubuntu: [{ owners: ["099720109477"] }] } },
      resource: {
        aws_instance: { web: [{ ami: "${data.aws_ami.ubuntu.id}" }] },
      },
    };
    const g = buildFixtureGraph(tree);
    expect(g.nodes.map((n) => n.address)).toEqual(["aws_instance.web"]); // data is not a node
    expect(g.edges).toEqual([]); // ref to data → no resource edge
    expect(g.nodes[0].hasDynamic).toBe(true);
  });

  test("an expression whose AST found no references contributes no edge", () => {
    // `${var.m["aws_s3_bucket.assets.arn"]}` — the AST reports only `var.m`;
    // the quoted address inside the brackets is a map key, not a reference.
    const tree: Hcl2JsonTree = {
      resource: {
        aws_s3_bucket: { assets: [{ bucket: "x" }] },
        aws_lambda_function: { api: [{ handler: '${var.m["aws_s3_bucket.assets.arn"]}' }] },
      },
    };
    const g = buildFixtureGraph(tree);
    expect(g.edges).toEqual([]);
  });

  test("a dotted identity attr resolves through nested blocks (#998)", () => {
    const tree: Hcl2JsonTree = {
      resource: {
        kubernetes_manifest: {
          app_config: [{ manifest: { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "app-config", namespace: "web" } } }],
          templated: [{ manifest: { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "${var.name}" } } }],
        },
        aws_s3_bucket: { assets: [{ bucket: "myapp-assets-prod" }] },
      },
    };
    const g = buildFixtureGraph(tree);
    const byAddr = Object.fromEntries(g.nodes.map((n) => [n.address, n]));
    expect(byAddr["kubernetes_manifest.app_config"].identity).toBe("app-config");
    expect(byAddr["kubernetes_manifest.templated"].identity).toBeUndefined(); // interpolated
    expect(byAddr["aws_s3_bucket.assets"].identity).toBe("myapp-assets-prod"); // flat attr unaffected
  });

  test("an output block referencing a resource is an inbound edge, tagged as an output (#1638)", () => {
    const tree: Hcl2JsonTree = {
      resource: { aws_s3_bucket: { assets: [{ bucket: "x" }] } },
      output: {
        assets_bucket: [{ value: "${aws_s3_bucket.assets.bucket}" }],
        assets_pair: [{ value: ["${aws_s3_bucket.assets.arn}", "${aws_s3_bucket.assets.id}"], description: "both" }],
      },
    };
    const g = buildFixtureGraph(tree);

    // An output is a referrer, never a node — nothing carves an output.
    expect(g.nodes.map((n) => n.address)).toEqual(["aws_s3_bucket.assets"]);
    expect(inboundEdges(g, "aws_s3_bucket.assets")).toEqual([
      {
        from: "output.assets_bucket",
        to: "aws_s3_bucket.assets",
        attrs: ["bucket"],
        via: ["value"],
        fromKind: "output",
      },
      {
        from: "output.assets_pair",
        to: "aws_s3_bucket.assets",
        attrs: ["arn", "id"],
        via: ["value"],
        fromKind: "output",
      },
    ]);
    // Nothing can depend on an output in turn.
    expect(outboundEdges(g, "output.assets_bucket").map((e) => e.to)).toEqual(["aws_s3_bucket.assets"]);
    expect(inboundEdges(g, "output.assets_bucket")).toEqual([]);
  });

  test("an output referencing a var or a data source contributes no edge", () => {
    const tree: Hcl2JsonTree = {
      data: { aws_ami: { ubuntu: [{ owners: ["1"] }] } },
      resource: { aws_s3_bucket: { assets: [{ bucket: "x" }] } },
      output: {
        name: [{ value: "${var.name}" }],
        ami: [{ value: "${data.aws_ami.ubuntu.id}" }],
      },
    };
    expect(buildFixtureGraph(tree).edges).toEqual([]);
  });

  test("var / local references are not edges", () => {
    const tree: Hcl2JsonTree = {
      resource: {
        aws_s3_bucket: { assets: [{ bucket: "${var.name}", tags: { env: "${local.env}" } }] },
      },
    };
    const g = buildFixtureGraph(tree);
    expect(g.edges).toEqual([]);
    expect(g.nodes[0].hasDynamic).toBe(false); // var/local alone are not the dynamic markers
  });
});

describe("refFromAccessor", () => {
  test("classifies resource, module, and data accessors", () => {
    expect(refFromAccessor("aws_s3_bucket.assets.bucket")).toEqual({
      address: "aws_s3_bucket.assets",
      attr: "bucket",
    });
    expect(refFromAccessor("aws_s3_bucket.assets")).toEqual({ address: "aws_s3_bucket.assets", attr: undefined });
    expect(refFromAccessor("module.cdn.domain")).toEqual({ address: "module.cdn", attr: "domain" });
    expect(refFromAccessor("data.aws_ami.ubuntu.id")).toEqual({ address: "data.aws_ami.ubuntu", attr: "id" });
  });

  test("non-resource heads are not references", () => {
    for (const accessor of ["var.name", "local.env", "each.value", "count.index", "self.arn", "path.module", "terraform.workspace"]) {
      expect(refFromAccessor(accessor)).toBeNull();
    }
  });

  test("quoted map keys and numeric indexes never become the attribute", () => {
    // `var.m["aws_s3_bucket.assets.arn"]` → the AST renders `var.m."aws_s3_bucket.assets.arn"`
    expect(refFromAccessor('var.m."aws_s3_bucket.assets.arn"')).toBeNull();
    // `aws_instance.web[0].id` → `aws_instance.web.0.id`
    expect(refFromAccessor("aws_instance.web.0.id")).toEqual({ address: "aws_instance.web", attr: "id" });
    // `aws_s3_bucket.assets.tags["a.b"]` → the key must not shadow the attr
    expect(refFromAccessor('aws_s3_bucket.assets.tags."a.b"')).toEqual({
      address: "aws_s3_bucket.assets",
      attr: "tags",
    });
  });
});
