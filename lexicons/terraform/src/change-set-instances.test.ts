/**
 * A `count = 3` resource's stored change set carries three node ids (#4454).
 *
 * The graph is read in process the way `chant graph --format ir` builds it
 * for a terraform root: the root's entities, `buildGraphIr`, then
 * `withInstanceNodes`. The plan is a `show -json` shape with one
 * `resource_changes` row per instance, as terraform prints a `count` block.
 */

import { describe, expect, test } from "vitest";
import { composeChangeSet, verifyChangeSetDigest } from "@intentius/chant/change-set";
import { graphNodeFor, mapChangeSetToGraph } from "@intentius/chant/change-set-graph";
import { buildGraphIr, withInstanceNodes } from "@intentius/chant/graph-ir";
import { terraformChangeSetPart } from "./change-set";
import { literalInstanceKeys, parseTerraformRootContent } from "./hcl/parse";

const SOURCE = `resource "aws_eip" "pool" {
  count  = 3
  domain = "vpc"
}

resource "aws_s3_bucket" "logs" {
  bucket = "logs"
}
`;

const create = (address: string, index?: number) => ({
  address,
  mode: "managed",
  type: address.split(".")[0],
  name: address.split(".")[1]!.replace(/\[.*$/, ""),
  ...(index !== undefined ? { index } : {}),
  change: { actions: ["create"], before: null, after: { domain: "vpc" }, after_unknown: { id: true } },
});

const PLAN = {
  format_version: "1.2",
  resource_changes: [create("aws_eip.pool[0]", 0), create("aws_eip.pool[1]", 1), create("aws_eip.pool[2]", 2), create("aws_s3_bucket.logs")],
};

describe("instance nodes for a count block", () => {
  test("a literal count gives the block three instance keys", () => {
    expect(literalInstanceKeys({ count: 3 })).toEqual(["[0]", "[1]", "[2]"]);
    expect(literalInstanceKeys({ count: "${var.n}" })).toBeUndefined();
    expect(literalInstanceKeys({ for_each: { b: 1, a: 2 } })).toEqual(['["a"]', '["b"]']);
    expect(literalInstanceKeys({ for_each: '${toset(["x", "y"])}' })).toEqual(['["x"]', '["y"]']);
  });

  test("the graph has the block node and one instance node per index, each naming the block", async () => {
    const entities = await parseTerraformRootContent(SOURCE, "estate");
    const ir = withInstanceNodes(buildGraphIr(entities), entities);
    const pool = ir.nodes.filter((n) => n.id.startsWith("estate/aws_eip.pool"));
    expect(pool.map((n) => [n.id, n.instanceOf ?? null, n.instanceKey ?? null])).toEqual([
      ["estate/aws_eip.pool", null, null],
      ["estate/aws_eip.pool[0]", "estate/aws_eip.pool", "[0]"],
      ["estate/aws_eip.pool[1]", "estate/aws_eip.pool", "[1]"],
      ["estate/aws_eip.pool[2]", "estate/aws_eip.pool", "[2]"],
    ]);
    expect(ir.groups.byStack?.estate).toEqual(expect.arrayContaining(["estate/aws_eip.pool[0]", "estate/aws_eip.pool[2]"]));
  });

  test("the stored change set carries three node ids for the three instances", async () => {
    const entities = await parseTerraformRootContent(SOURCE, "estate");
    const ir = withInstanceNodes(buildGraphIr(entities), entities);
    const doc = composeChangeSet([terraformChangeSetPart({ member: "estate", plan: PLAN })]);
    const mapped = mapChangeSetToGraph(doc, { member: "infra", at: null, ids: ir.nodes.map((n) => n.id) });

    const pool = mapped.entries.filter((e) => e.type === "aws_eip");
    expect(pool.map((e) => [e.address, e.node, e.instanceOf])).toEqual([
      ["aws_eip.pool[0]", "infra/estate/aws_eip.pool[0]", "infra/estate/aws_eip.pool"],
      ["aws_eip.pool[1]", "infra/estate/aws_eip.pool[1]", "infra/estate/aws_eip.pool"],
      ["aws_eip.pool[2]", "infra/estate/aws_eip.pool[2]", "infra/estate/aws_eip.pool"],
    ]);
    expect(new Set(pool.map((e) => e.node)).size).toBe(3);
    const logs = mapped.entries.find((e) => e.address === "aws_s3_bucket.logs")!;
    expect(logs.node).toBe("infra/estate/aws_s3_bucket.logs");
    expect(logs.instanceOf).toBeUndefined();
    // Node ids are not hashed.
    expect(mapped.digest).toBe(doc.digest);
    expect(verifyChangeSetDigest(mapped)).toBe(true);
  });

  test("an instance the graph cannot count still gets its instance id, and a drift row the same", async () => {
    const entities = await parseTerraformRootContent(SOURCE.replace("count  = 3", "count  = var.n"), "estate");
    const ir = withInstanceNodes(buildGraphIr(entities), entities);
    expect(ir.nodes.some((n) => n.instanceOf)).toBe(false);
    const graph = { member: null, at: null, ids: ir.nodes.map((n) => n.id) };
    expect(graphNodeFor({ member: "estate", planner: "terraform", address: "aws_eip.pool[1]" }, graph)).toMatchObject({
      node: "estate/aws_eip.pool[1]",
      instanceOf: "estate/aws_eip.pool",
    });
    // Under an expanded module call the module key sits on the call's segment (#4486).
    expect(graphNodeFor({ member: "estate", planner: "terraform", address: "module.app[0].aws_eip.pool[1]" }, { ...graph, ids: ["estate/module.app/aws_eip.pool"] })).toEqual({
      node: "estate/module.app[0]/aws_eip.pool[1]",
      instanceOf: "estate/module.app/aws_eip.pool",
    });
  });
});
