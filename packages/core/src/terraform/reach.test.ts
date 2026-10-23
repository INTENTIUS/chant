import { describe, expect, test } from "vitest";
import { join } from "path";
import { loadHcl2json, parseTerraformDir } from "./parse";
import { carveIndex, reach } from "./reach";
import type { TfEdge, TfGraph, TfNode } from "./types";

/**
 * #2325: transitive reachability over the carve graph. The fixture assertions
 * run against depth-estate (#2323) as the production parse builds it; the
 * cycle and cross-stack cases need graphs Terraform would not produce, so they
 * are hand-built.
 */
let parserAvailable = false;
try {
  await loadHcl2json();
  parserAvailable = true;
} catch {
  parserAvailable = false;
}

const ESTATE = join(__dirname, "__fixtures__", "depth-estate");
const STATE = join(ESTATE, "terraform.tfstate");

const node = (address: string, extra: Partial<TfNode> = {}): TfNode => {
  const [type, name] = address.split(".");
  return { address, kind: "resource", type, name, instances: 1, hasDynamic: false, ...extra };
};
const edge = (from: string, to: string, extra: Partial<TfEdge> = {}): TfEdge => ({ from, to, attrs: [], via: [], ...extra });

describe("reach against depth-estate", () => {
  test("the subnet group's radius is the cluster, its instance and the Lambda, plus one output, two deep", async () => {
    if (!parserAvailable) return;
    const graph = await parseTerraformDir(ESTATE);
    expect(reach(graph, "aws_db_subnet_group.main")).toEqual({
      address: "aws_db_subnet_group.main",
      resources: ["aws_lambda_function.api", "aws_rds_cluster.main", "aws_rds_cluster_instance.one"],
      outputs: ["output.db_endpoint"],
      depth: 2,
      crossStack: [],
      hidden: [],
    });
    const vpc = reach(graph, "aws_vpc.main");
    expect(vpc.resources).toHaveLength(13);
    expect(vpc.outputs).toEqual(["output.db_endpoint", "output.lb_dns"]);
    expect(vpc.depth).toBe(3);
  });

  test("folds contract first: the bucket's radius is the Lambda alone, not its own versioning block", async () => {
    if (!parserAvailable) return;
    const graph = await parseTerraformDir(ESTATE);
    // The uncontracted graph has the versioning block reading the bucket.
    expect(graph.edges.some((e) => e.from === "aws_s3_bucket_versioning.assets" && e.to === "aws_s3_bucket.assets")).toBe(true);
    expect(reach(graph, "aws_s3_bucket.assets").resources).toEqual(["aws_lambda_function.api"]);
    // Asking from the folded child walks from its parent.
    expect(reach(graph, "aws_s3_bucket_versioning.assets").address).toBe("aws_s3_bucket.assets");
    expect(carveIndex(graph).membersOf("aws_s3_bucket.assets")).toEqual(["aws_s3_bucket.assets", "aws_s3_bucket_versioning.assets"]);
  });

  test("outputs are counted apart and end the walk", async () => {
    if (!parserAvailable) return;
    const graph = await parseTerraformDir(ESTATE);
    const lb = reach(graph, "aws_lb.public");
    expect(lb.resources).toEqual(["aws_lb_listener.https"]);
    expect(lb.outputs).toEqual(["output.lb_dns"]);
    expect(reach(graph, "aws_lb_listener.https")).toMatchObject({ resources: [], outputs: [], depth: 0 });
  });

  test("a module and an unresolved count are named as hiding their contents; --state resolves the count", async () => {
    if (!parserAvailable) return;
    const bare = await parseTerraformDir(ESTATE);
    expect(reach(bare, "aws_vpc.main").hidden).toEqual(["aws_subnet.private", "module.platform"]);
    const withState = await parseTerraformDir(ESTATE, { statePath: STATE });
    expect(reach(withState, "aws_vpc.main").hidden).toEqual(["module.platform"]);
  });

  test("direction out walks what a node needs", async () => {
    if (!parserAvailable) return;
    const graph = await parseTerraformDir(ESTATE);
    expect(reach(graph, "aws_rds_cluster_instance.one", { direction: "out" }).resources).toEqual([
      "aws_db_subnet_group.main",
      "aws_kms_key.data",
      "aws_rds_cluster.main",
      "aws_security_group.db",
      "aws_subnet.a",
      "aws_subnet.b",
      "aws_vpc.main",
    ]);
  });
});

describe("reach on hand-built graphs", () => {
  test("a depends_on cycle terminates and does not count the start", () => {
    const graph: TfGraph = {
      nodes: [node("aws_sqs_queue.a"), node("aws_sqs_queue.b"), node("aws_sqs_queue.c")],
      edges: [
        edge("aws_sqs_queue.a", "aws_sqs_queue.b", { via: ["depends_on"] }),
        edge("aws_sqs_queue.b", "aws_sqs_queue.c", { via: ["depends_on"] }),
        edge("aws_sqs_queue.c", "aws_sqs_queue.a", { via: ["depends_on"] }),
      ],
    };
    expect(reach(graph, "aws_sqs_queue.a")).toMatchObject({ resources: ["aws_sqs_queue.b", "aws_sqs_queue.c"], depth: 2 });
  });

  test("what is reachable only through a crossStack edge is listed apart", () => {
    const graph: TfGraph = {
      nodes: [node("A/Bucket"), node("A/Fn"), node("B/Fn"), node("B/Alarm")],
      edges: [
        edge("A/Fn", "A/Bucket"),
        edge("B/Fn", "A/Bucket", { crossStack: true }),
        edge("B/Alarm", "B/Fn"),
      ],
    };
    expect(reach(graph, "A/Bucket")).toMatchObject({ resources: ["A/Fn", "B/Alarm", "B/Fn"], crossStack: ["B/Alarm", "B/Fn"] });
  });

  test("an address the graph does not hold is an error, not an empty radius", () => {
    expect(() => reach({ nodes: [], edges: [] }, "aws_vpc.nope")).toThrow(/not a resource or module/);
  });

  test("under 100 ms at 6 000 nodes, index included", () => {
    // Layered like the spike's synthetic estates: 60 layers of 100, each node
    // reading two nodes in the layer below, about 11 800 edges. Node i reads
    // 2i and 2i+1 below it, so the dependents of one bottom node double per
    // layer and a walk from it covers almost everything.
    const layers = 60;
    const width = 100;
    const nodes: TfNode[] = [];
    const edges: TfEdge[] = [];
    for (let l = 0; l < layers; l++) {
      for (let i = 0; i < width; i++) {
        nodes.push(node(`aws_sqs_queue.l${l}_${i}`));
        if (l > 0) {
          edges.push(edge(`aws_sqs_queue.l${l}_${i}`, `aws_sqs_queue.l${l - 1}_${(2 * i) % width}`));
          edges.push(edge(`aws_sqs_queue.l${l}_${i}`, `aws_sqs_queue.l${l - 1}_${(2 * i + 1) % width}`));
        }
      }
    }
    reach({ nodes, edges }, "aws_sqs_queue.l0_0"); // warm the JIT on a different graph object
    const graph: TfGraph = { nodes, edges };
    const started = performance.now();
    const r = reach(graph, "aws_sqs_queue.l0_0");
    const took = performance.now() - started;
    expect(r.resources.length).toBeGreaterThan(5_000);
    expect(took).toBeLessThan(100);
  });
});
