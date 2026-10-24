import { describe, test, expect } from "vitest";
import { carveJson } from "./carve";
import { boundaryIndex, boundaryReport } from "../../terraform/carve";
import { scoreEstate } from "../../terraform/score";
import type { TfEdge, TfGraph, TfNode } from "../../terraform/types";

const node = (type: string, name: string): TfNode => ({
  address: `${type}.${name}`,
  kind: "resource",
  type,
  name,
  instances: 1,
  hasDynamic: false,
});

const edge = (from: string, to: string, extra: Partial<TfEdge> = {}): TfEdge => ({
  from,
  to,
  attrs: ["id"],
  via: ["bucket"],
  ...extra,
});

/** A fixture with a fold, an output edge, a module, an unmapped type and a duplicate edge. */
function fixture(): TfGraph {
  return {
    nodes: [
      node("aws_s3_bucket", "assets"),
      node("aws_s3_bucket_versioning", "assets"),
      node("aws_lambda_function", "api"),
      node("aws_sqs_queue", "q"),
      node("random_pet", "name"),
      { address: "module.cdn", kind: "module", name: "cdn", instances: 1, hasDynamic: false },
    ],
    edges: [
      edge("aws_s3_bucket_versioning.assets", "aws_s3_bucket.assets"),
      edge("aws_lambda_function.api", "aws_s3_bucket.assets", { attrs: ["bucket"] }),
      edge("aws_lambda_function.api", "aws_s3_bucket.assets", { attrs: ["arn"], via: ["env"] }),
      edge("output.bucket", "aws_s3_bucket.assets", { fromKind: "output", via: ["value"] }),
      edge("aws_lambda_function.api", "aws_sqs_queue.q"),
      edge("module.cdn", "aws_lambda_function.api"),
    ],
  };
}

/** The old path: every resource's boundary rescored the whole estate. */
function legacyJson(graph: TfGraph) {
  const results = scoreEstate(graph);
  return results.map((r) => {
    const report = boundaryReport(graph, r.address, { dialect: "terraform" });
    return report ? { ...r, boundary: { inbound: report.inbound, outbound: report.outbound } } : r;
  });
}

function chain(n: number): TfGraph {
  const nodes: TfNode[] = [];
  const edges: TfEdge[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push(node("aws_sqs_queue", `q${i}`));
    if (i > 0) edges.push(edge(`aws_sqs_queue.q${i}`, `aws_sqs_queue.q${i - 1}`));
    if (i > 1) edges.push(edge(`aws_sqs_queue.q${i}`, `aws_sqs_queue.q${i - 2}`));
  }
  return { nodes, edges };
}

describe("carve advise scores the estate once (#4391)", () => {
  test("output is byte-identical to the per-resource rescoring path", () => {
    const graph = fixture();
    const payload = carveJson({ ok: true, from: "x", source: "terraform", results: scoreEstate(graph), graph });
    expect(JSON.stringify(payload.resources)).toBe(JSON.stringify(legacyJson(graph)));
    expect(payload.resources.some((r) => r.boundary?.inbound.length)).toBe(true);
  });

  test("a supplied peelability and edge index give the same report", () => {
    const graph = fixture();
    for (const r of scoreEstate(graph)) {
      expect(JSON.stringify(boundaryReport(graph, r.address, { peelability: r, index: boundaryIndex(graph) }))).toBe(
        JSON.stringify(boundaryReport(graph, r.address)),
      );
    }
  });

  test("on a few thousand nodes the old path costs more per resource than the whole new pass", () => {
    const graph = chain(3000);
    // Radius is its own walk per node (#2326), not what this test is about.
    const t0 = performance.now();
    const results = scoreEstate(graph, { radius: false });
    const payload = carveJson({ ok: true, from: "x", source: "terraform", results, graph });
    const fresh = performance.now() - t0;
    expect(payload.resources).toHaveLength(3000);

    // Rescoring is O(V) per resource, so 50 of them already outweigh the one pass over all 3000.
    const sample = results.slice(0, 50);
    const t1 = performance.now();
    for (const r of sample) boundaryReport(graph, r.address);
    const legacy = performance.now() - t1;
    expect(legacy).toBeGreaterThan(fresh);
  });
});
