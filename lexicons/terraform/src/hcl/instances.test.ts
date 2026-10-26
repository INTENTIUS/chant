/**
 * Instance nodes counted from variables, and under expanded module calls
 * (chant #4486).
 *
 * The fixture is `src/__fixtures__/instance-vars/app/`, rendered through
 * `renderTerraformRoots`, then core's `buildGraphIr` and `withInstanceNodes`,
 * which is how `chant graph --format ir` builds a terraform root's graph.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildGraphIr, withInstanceNodes, type GraphIR } from "@intentius/chant/graph-ir";
import { graphNodeFor } from "@intentius/chant/change-set-graph";
import { terraformInstancePath } from "@intentius/chant/instance-nodes";
import type { Declarable } from "@intentius/chant/declarable";
import { renderTerraformRoots } from "./roots";

const TREE = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__", "instance-vars");

let entities: Map<string, Declarable>;
let ir: GraphIR;

beforeAll(async () => {
  const rendered = await renderTerraformRoots({ projectRoot: TREE, roots: { estate: { dir: "./app" } } });
  expect(rendered.warnings).toEqual([]);
  entities = rendered.entities;
  ir = withInstanceNodes(buildGraphIr(entities), entities);
});

/** The instance nodes under one block node, as `[id, instanceKey, instanceScope]`. */
function instancesOf(block: string): Array<[string, string | null, string | null]> {
  return ir.nodes
    .filter((n) => n.instanceOf === block)
    .map((n) => [n.id, n.instanceKey ?? null, n.instanceScope ?? null] as [string, string | null, string | null])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

describe("count and for_each resolved from variables", () => {
  it("counts `count = var.n` from terraform.tfvars over the default", () => {
    expect(instancesOf("estate/aws_eip.pool")).toEqual([
      ["estate/aws_eip.pool[0]", "[0]", null],
      ["estate/aws_eip.pool[1]", "[1]", null],
      ["estate/aws_eip.pool[2]", "[2]", null],
    ]);
  });

  it("keys `for_each = var.names` over a set variable's default", () => {
    expect(instancesOf("estate/aws_s3_bucket.named").map((i) => i[0])).toEqual([
      'estate/aws_s3_bucket.named["a"]',
      'estate/aws_s3_bucket.named["b"]',
    ]);
  });

  it("counts `count = length(var.zones)`", () => {
    expect(instancesOf("estate/aws_sqs_queue.zoned").map((i) => i[0])).toEqual([
      "estate/aws_sqs_queue.zoned[0]",
      "estate/aws_sqs_queue.zoned[1]",
    ]);
  });

  it("leaves a block whose variable has no known value as one node", () => {
    expect(instancesOf("estate/aws_sns_topic.uncounted")).toEqual([]);
    expect(ir.nodes.some((n) => n.id === "estate/aws_sns_topic.uncounted")).toBe(true);
  });
});

describe("instances under an expanded module call", () => {
  it("gives the module call its own instance nodes", () => {
    expect(instancesOf("estate/module.app")).toEqual([
      ["estate/module.app[0]", "[0]", null],
      ["estate/module.app[1]", "[1]", null],
    ]);
  });

  it("puts the module key on the call segment and the block key at the end", () => {
    // `size = var.n` passes the root's 3 into the child's `count = var.size`.
    expect(instancesOf("estate/module.app/aws_instance.web")).toEqual([
      ["estate/module.app[0]/aws_instance.web[0]", "[0]", "module.app[0]"],
      ["estate/module.app[0]/aws_instance.web[1]", "[1]", "module.app[0]"],
      ["estate/module.app[0]/aws_instance.web[2]", "[2]", "module.app[0]"],
      ["estate/module.app[1]/aws_instance.web[0]", "[0]", "module.app[1]"],
      ["estate/module.app[1]/aws_instance.web[1]", "[1]", "module.app[1]"],
      ["estate/module.app[1]/aws_instance.web[2]", "[2]", "module.app[1]"],
    ]);
  });

  it("gives a block that is not expanded itself one instance per module instance, with no instanceKey", () => {
    expect(instancesOf("estate/module.app/aws_iam_role.runner")).toEqual([
      ["estate/module.app[0]/aws_iam_role.runner", null, "module.app[0]"],
      ["estate/module.app[1]/aws_iam_role.runner", null, "module.app[1]"],
    ]);
    expect(instancesOf("estate/module.edge/aws_route53_record.front")).toEqual([
      ['estate/module.edge["east"]/aws_route53_record.front', null, 'module.edge["east"]'],
      ['estate/module.edge["west"]/aws_route53_record.front', null, 'module.edge["west"]'],
    ]);
  });

  it("keeps the block node as the rollup, in the same groups", () => {
    expect(ir.nodes.some((n) => n.id === "estate/module.app/aws_instance.web" && !n.instanceOf)).toBe(true);
    expect(ir.groups.byStack?.estate).toEqual(
      expect.arrayContaining(["estate/module.app/aws_instance.web", "estate/module.app[1]/aws_instance.web[2]"]),
    );
  });

  it("places a plan address on the same id the graph lists", () => {
    const graph = { member: null, at: null, ids: ir.nodes.map((n) => n.id) };
    expect(graphNodeFor({ member: "estate", planner: "terraform", address: "module.app[1].aws_instance.web[2]" }, graph)).toEqual({
      node: "estate/module.app[1]/aws_instance.web[2]",
      instanceOf: "estate/module.app/aws_instance.web",
    });
    expect(graphNodeFor({ member: "estate", planner: "tofu", address: 'module.edge["east"].aws_route53_record.front' }, graph)).toEqual({
      node: 'estate/module.edge["east"]/aws_route53_record.front',
      instanceOf: "estate/module.edge/aws_route53_record.front",
    });
    for (const n of ir.nodes.filter((x) => x.instanceOf)) expect(graph.ids).toContain(n.id);
  });
});

describe("terraformInstancePath", () => {
  it("maps an address to its block key and instance key", () => {
    expect(terraformInstancePath("aws_eip.pool[1]")).toEqual({ block: "aws_eip.pool", instance: "aws_eip.pool[1]", key: "[1]" });
    expect(terraformInstancePath("aws_eip.pool")).toBeUndefined();
    expect(terraformInstancePath("module.app[0].aws_eip.pool[1]")).toEqual({
      block: "module.app/aws_eip.pool",
      instance: "module.app[0]/aws_eip.pool[1]",
      key: "[1]",
      scope: "module.app[0]",
    });
    expect(terraformInstancePath('module.a["x.y"].module.b.data.http.site')).toEqual({
      block: "module.a/module.b/data.http.site",
      instance: 'module.a["x.y"]/module.b/data.http.site',
      scope: 'module.a["x.y"].module.b',
    });
    expect(terraformInstancePath("module.app[0]")).toEqual({ block: "module.app", instance: "module.app[0]", key: "[0]" });
  });
});
