import { describe, expect, test } from "vitest";
import { join } from "path";
import { loadHcl2json, parseTerraformDir } from "./parse";
import { closure, components, cuts } from "./cuts";
import type { TfEdge, TfGraph, TfNode } from "./types";

/**
 * #3909: cuts and reference-closed sets. The proof runs against depth-estate
 * (#2323) as `parseTerraformDir` builds it; several components, a cycle, a
 * straddling output and cross-stack edges are on hand-built graphs.
 */
let parserAvailable = false;
try {
  await loadHcl2json();
  parserAvailable = true;
} catch {
  parserAvailable = false;
}

const ESTATE = join(__dirname, "__fixtures__", "depth-estate");
const ends = (edges: TfEdge[]): string[] => edges.map((e) => `${e.from} -> ${e.to}`);

const node = (address: string, extra: Partial<TfNode> = {}): TfNode => {
  const [type, name] = address.split(".");
  return { address, kind: "resource", type, name, instances: 1, hasDynamic: false, ...extra };
};
const edge = (from: string, to: string, extra: Partial<TfEdge> = {}): TfEdge => ({ from, to, attrs: [], via: [], ...extra });

const DEPTH_ESTATE_BLOCKS = [
  "aws_cloudwatch_log_group.api",
  "aws_db_subnet_group.main",
  "aws_kms_key.data",
  "aws_lambda_function.api",
  "aws_lb.public",
  "aws_lb_listener.https",
  "aws_lb_target_group.app",
  "aws_rds_cluster.main",
  "aws_rds_cluster_instance.one",
  "aws_s3_bucket.assets",
  "aws_s3_bucket_versioning.assets",
  "aws_security_group.app",
  "aws_security_group.db",
  "aws_subnet.a",
  "aws_subnet.b",
  "aws_subnet.private",
  "aws_vpc.main",
  "module.platform",
];

describe("against depth-estate", () => {
  test("components match the pinned list: one, with the module and the count hiding what it holds", async () => {
    if (!parserAvailable) return;
    const graph = await parseTerraformDir(ESTATE);
    expect(components(graph)).toEqual([
      {
        resources: DEPTH_ESTATE_BLOCKS,
        outputs: ["output.db_endpoint", "output.lb_dns"],
        instances: "unknown",
        hiddenBy: ["aws_subnet.private", "module.platform"],
      },
    ]);
  });

  test("cuts of a hand-picked set name each crossing edge with its direction", async () => {
    if (!parserAvailable) return;
    const graph = await parseTerraformDir(ESTATE);
    const c = cuts(graph, ["aws_rds_cluster.main", "aws_rds_cluster_instance.one"]);
    expect(ends(c.inbound)).toEqual([
      "aws_lambda_function.api -> aws_rds_cluster.main",
      "output.db_endpoint -> aws_rds_cluster.main",
    ]);
    expect(ends(c.outbound)).toEqual([
      "aws_rds_cluster.main -> aws_db_subnet_group.main",
      "aws_rds_cluster.main -> aws_kms_key.data",
      "aws_rds_cluster.main -> aws_security_group.db",
    ]);
    expect(c.counts).toEqual({
      inbound: { resources: 1, outputs: 1, crossStack: 0 },
      outbound: { resources: 3, outputs: 0, crossStack: 0 },
    });
    expect(c.bothWays).toBe(true);
  });

  test("closure from a leaf with outbound allowed leaves only outbound cuts", async () => {
    if (!parserAvailable) return;
    const graph = await parseTerraformDir(ESTATE);
    const leaf = closure(graph, ["aws_rds_cluster_instance.one"], "outbound");
    expect(leaf.resources).toEqual(["aws_rds_cluster_instance.one"]);
    expect(leaf.inbound).toEqual([]);
    expect(ends(leaf.outbound)).toEqual(["aws_rds_cluster_instance.one -> aws_rds_cluster.main"]);

    // A seed with dependents takes them all, outputs included.
    const key = closure(graph, ["aws_kms_key.data"], "outbound");
    expect(key.resources).toEqual(["aws_kms_key.data", "aws_lambda_function.api", "aws_rds_cluster.main", "aws_rds_cluster_instance.one"]);
    expect(key.outputs).toEqual(["output.db_endpoint"]);
    expect(key.inbound).toEqual([]);
    expect(key.outbound.length).toBeGreaterThan(0);
    expect(key.instances).toBe(4);
  });

  test("closure with inbound allowed takes what the seed depends on, and leaves only inbound cuts", async () => {
    if (!parserAvailable) return;
    const graph = await parseTerraformDir(ESTATE);
    const c = closure(graph, ["aws_rds_cluster_instance.one"], "inbound");
    expect(c.outbound).toEqual([]);
    expect(c.resources).toContain("aws_vpc.main");
    expect(c.inbound.every((e) => !c.resources.includes(e.from))).toBe(true);
  });

  test("closure with none allowed returns the leaf's whole component", async () => {
    if (!parserAvailable) return;
    const graph = await parseTerraformDir(ESTATE);
    const c = closure(graph, ["aws_rds_cluster_instance.one"], "none");
    expect(c.resources).toEqual(DEPTH_ESTATE_BLOCKS);
    expect(c.outputs).toEqual(["output.db_endpoint", "output.lb_dns"]);
    expect([...c.inbound, ...c.outbound]).toEqual([]);
    expect(c.instances).toBe("unknown");
  });

  test("a set that splits a fold is contracted before its cuts are counted", async () => {
    if (!parserAvailable) return;
    const graph = await parseTerraformDir(ESTATE);
    const child = cuts(graph, ["aws_s3_bucket_versioning.assets"]);
    const parent = cuts(graph, ["aws_s3_bucket.assets"]);
    expect(child).toEqual(parent);
    expect(parent.resources).toEqual(["aws_s3_bucket.assets", "aws_s3_bucket_versioning.assets"]);
    expect(ends(parent.inbound)).toEqual(["aws_lambda_function.api -> aws_s3_bucket.assets"]);
    expect(parent.outbound).toEqual([]);
  });
});

describe("on hand-built graphs", () => {
  test("separate components stay separate, and an output never joins them", () => {
    const graph: TfGraph = {
      nodes: [node("aws_sqs_queue.a"), node("aws_sqs_queue.b"), node("aws_sns_topic.c")],
      edges: [
        edge("aws_sqs_queue.b", "aws_sqs_queue.a"),
        edge("output.both", "aws_sqs_queue.a", { fromKind: "output" }),
        edge("output.both", "aws_sns_topic.c", { fromKind: "output" }),
      ],
    };
    expect(components(graph)).toEqual([
      { resources: ["aws_sns_topic.c"], outputs: ["output.both"], instances: 1 },
      { resources: ["aws_sqs_queue.a", "aws_sqs_queue.b"], outputs: ["output.both"], instances: 2 },
    ]);
    // The straddling output stays outside a none-closure, its read left as a cut.
    const c = closure(graph, ["aws_sqs_queue.a"], "none");
    expect(c.outputs).toEqual([]);
    expect(ends(c.inbound)).toEqual(["output.both -> aws_sqs_queue.a"]);
  });

  test("a depends_on cycle terminates in every closure", () => {
    const graph: TfGraph = {
      nodes: [node("aws_sqs_queue.a"), node("aws_sqs_queue.b"), node("aws_sqs_queue.c")],
      edges: [edge("aws_sqs_queue.a", "aws_sqs_queue.b"), edge("aws_sqs_queue.b", "aws_sqs_queue.c"), edge("aws_sqs_queue.c", "aws_sqs_queue.a")],
    };
    for (const allow of ["inbound", "outbound", "none"] as const) {
      expect(closure(graph, ["aws_sqs_queue.a"], allow).resources).toEqual(["aws_sqs_queue.a", "aws_sqs_queue.b", "aws_sqs_queue.c"]);
    }
  });

  test("crossStack cuts are counted apart", () => {
    const graph: TfGraph = {
      nodes: [node("Data/Bucket"), node("App/Fn")],
      edges: [edge("App/Fn", "Data/Bucket", { crossStack: true })],
    };
    expect(cuts(graph, ["Data/Bucket"]).counts.inbound).toEqual({ resources: 1, outputs: 0, crossStack: 1 });
  });

  test("an address the graph does not hold is an error", () => {
    expect(() => cuts({ nodes: [], edges: [] }, ["aws_vpc.nope"])).toThrow(/not a resource, module or output/);
  });
});
