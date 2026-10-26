/**
 * The expansion forms #4489 counts, and the rollup reason on every block the
 * declared graph still leaves as one node. The fixture is
 * `src/__fixtures__/instance-forms/app/`, built as `chant graph --format ir`
 * builds a terraform root's graph.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildGraphIr, withInstanceNodes, type GraphIR, type IRNode } from "@intentius/chant/graph-ir";
import { INSTANCE_ROLLUP_CODES } from "@intentius/chant/instance-nodes";
import type { Declarable } from "@intentius/chant/declarable";
import { renderTerraformRoots } from "./roots";

const TREE = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__", "instance-forms");

let entities: Map<string, Declarable>;
let ir: GraphIR;

beforeAll(async () => {
  const rendered = await renderTerraformRoots({ projectRoot: TREE, roots: { estate: { dir: "./app" } } });
  entities = rendered.entities;
  ir = withInstanceNodes(buildGraphIr(entities), entities);
});

function instancesOf(block: string): string[] {
  return ir.nodes.filter((n) => n.instanceOf === block).map((n) => n.id).sort();
}

function node(id: string): IRNode {
  const n = ir.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
}

describe("forms counted since #4489", () => {
  it("counts `count = local.x` over a literal local", () => {
    expect(instancesOf("estate/aws_eip.local_count")).toEqual(["estate/aws_eip.local_count[0]", "estate/aws_eip.local_count[1]"]);
    expect(node("estate/aws_eip.local_count").instanceRollup).toBeUndefined();
  });

  it("counts `count = length(local.x)`", () => {
    expect(instancesOf("estate/aws_sqs_queue.local_length")).toHaveLength(3);
  });

  it("keys `for_each = toset(local.l)` and `for_each = local.m`", () => {
    expect(instancesOf("estate/aws_s3_bucket.local_set")).toEqual(['estate/aws_s3_bucket.local_set["p"]', 'estate/aws_s3_bucket.local_set["q"]']);
    expect(instancesOf("estate/aws_lb_listener.local_map")).toEqual(['estate/aws_lb_listener.local_map["http"]', 'estate/aws_lb_listener.local_map["https"]']);
  });

  it("counts `var.on ? 1 : 0` over a known bool, and a local that reads one", () => {
    expect(instancesOf("estate/aws_sns_topic.enabled")).toEqual(["estate/aws_sns_topic.enabled[0]"]);
    expect(instancesOf("estate/aws_sns_topic.disabled")).toEqual([]);
    expect(node("estate/aws_sns_topic.disabled").instanceRollup).toBeUndefined();
    expect(instancesOf("estate/aws_sns_topic.local_flag")).toHaveLength(2);
  });
});

describe("forms still rolled up, with the node's reason", () => {
  it.each([
    ["estate/aws_sns_topic.flag_unknown", "instances-value-unknown", "count", "var.flag ? 1 : 0"],
    ["estate/aws_sns_topic.local_unknown", "instances-value-unknown", "count", "local.computed"],
    ["estate/aws_iam_group.each", "instances-each-value", "for_each", "each.value"],
    ["estate/aws_iam_policy.arith", "instances-form-unread", "count", "local.replicas + 1"],
    ["estate/aws_eip.too_many", "instances-over-limit", "count", "300"],
    ["estate/module.svc", "instances-value-unknown", "count", "var.unknown"],
  ])("%s is one node with %s", (id, code, argument, expression) => {
    expect(instancesOf(id)).toEqual([]);
    expect(node(id).instanceRollup).toEqual({ code, argument, expression });
  });

  it("names merge() and a for expression", () => {
    expect(node("estate/aws_iam_user.merged").instanceRollup).toMatchObject({ code: "instances-merge", argument: "for_each" });
    expect(node("estate/aws_iam_user.merged").instanceRollup?.expression).toMatch(/^merge\(/);
    expect(node("estate/aws_iam_role.for_expr").instanceRollup).toMatchObject({ code: "instances-form-unread", argument: "for_each" });
  });

  it("names the uncounted module call on a block under it", () => {
    expect(instancesOf("estate/module.svc/aws_iam_role.runner")).toEqual([]);
    expect(node("estate/module.svc/aws_iam_role.runner").instanceRollup).toEqual({
      code: "instances-module-uncounted",
      argument: "count",
      expression: "var.unknown",
      call: "module.svc",
    });
  });

  it("uses only the listed codes", () => {
    for (const n of ir.nodes) {
      if (n.instanceRollup) expect(INSTANCE_ROLLUP_CODES).toContain(n.instanceRollup.code);
    }
  });
});
