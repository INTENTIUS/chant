import { describe, expect, test } from "vitest";
import { join } from "path";
import { carveAdvise, carveJson, formatCarveReport } from "../cli/commands/carve";
import { loadHcl2json } from "./parse";
import { blastRadius } from "./reach";
import { scoreEstate } from "./score";
import type { TfEdge, TfGraph, TfNode } from "./types";

/** #2326: blast radius on advise, its own axis beside the score. */
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

describe("radius on carve advise against depth-estate", () => {
  test("each resource carries its radius in the JSON, and the score still sums from its penalties", async () => {
    if (!parserAvailable) return;
    const result = await carveAdvise({ from: ESTATE, statePath: STATE });
    const byAddress = new Map(carveJson(result).resources.map((r) => [r.address, r]));
    expect(byAddress.get("aws_db_subnet_group.main")?.radius).toEqual({ resources: 3, outputs: 1, depth: 2 });
    expect(byAddress.get("aws_lambda_function.api")?.radius).toEqual({ resources: 0, outputs: 0, depth: 0 });
    for (const r of byAddress.values()) {
      if (r.breakdown.tier === null) continue;
      const sum = 100 + Object.values(r.breakdown.penalties).reduce((a, b) => a + b, 0);
      expect(r.score).toBe(Math.max(0, Math.min(100, sum)));
    }
  });

  test("the subnet group outranks the cluster on peelability and out-reaches it on radius", async () => {
    if (!parserAvailable) return;
    const result = await carveAdvise({ from: ESTATE });
    const group = result.results!.find((r) => r.address === "aws_db_subnet_group.main")!;
    const cluster = result.results!.find((r) => r.address === "aws_rds_cluster.main")!;
    expect(group.score).toBeGreaterThan(cluster.score);
    expect(group.radius!.resources).toBeGreaterThan(cluster.radius!.resources as number);
  });

  test("a module or an unresolved count makes the resource count unknown, and says which", async () => {
    if (!parserAvailable) return;
    const bare = await carveAdvise({ from: ESTATE });
    const vpc = bare.results!.find((r) => r.address === "aws_vpc.main")!;
    expect(vpc.radius).toEqual({ resources: "unknown", outputs: 2, depth: 3, hiddenBy: ["aws_subnet.private", "module.platform"] });
    const withState = await carveAdvise({ from: ESTATE, statePath: STATE });
    expect(withState.results!.find((r) => r.address === "aws_vpc.main")!.radius!.hiddenBy).toEqual(["module.platform"]);
  });

  test("the human report prints the radius as a column", async () => {
    if (!parserAvailable) return;
    const text = formatCarveReport(await carveAdvise({ from: ESTATE }));
    expect(text).toMatch(/ 80 {2}3\+1 d2 {2}aws_db_subnet_group\.main /);
    expect(text).toMatch(/\?\+2 d3 {2}aws_vpc\.main /);
    expect(text).toMatch(/ - {7}aws_lambda_function\.api /);
    expect(text).toContain("Radius: resources+outputs");
  });
});

describe("radius on hand-built graphs", () => {
  test("instances weight the count once state resolved them, and only then", () => {
    const graph = (resolved: boolean): TfGraph => ({
      nodes: [
        node("aws_vpc.main"),
        node("aws_subnet.private", { expansion: "count", hasDynamic: true, instances: resolved ? 3 : 1, ...(resolved ? { instancesFrom: "state" as const } : {}) }),
      ],
      edges: [edge("aws_subnet.private", "aws_vpc.main")],
    });
    expect(blastRadius(graph(true), "aws_vpc.main")).toEqual({ resources: 3, outputs: 0, depth: 1 });
    expect(blastRadius(graph(false), "aws_vpc.main")).toEqual({ resources: "unknown", outputs: 0, depth: 1, hiddenBy: ["aws_subnet.private"] });
  });

  test("on a graph with crossStack edges the radius splits off what sits across a stack boundary", () => {
    const graph: TfGraph = {
      nodes: [node("Data/Bucket"), node("Data/Reader"), node("App/Fn"), node("App/Alarm")],
      edges: [edge("Data/Reader", "Data/Bucket"), edge("App/Fn", "Data/Bucket", { crossStack: true }), edge("App/Alarm", "App/Fn")],
    };
    const bucket = scoreEstate(graph, { tierOf: () => ({ tier: 1, mapsTo: "AWS::S3::Bucket" }) }).find((r) => r.address === "Data/Bucket")!;
    expect(bucket.radius).toEqual({ resources: 3, outputs: 0, depth: 2, crossStack: 2 });
  });
});
