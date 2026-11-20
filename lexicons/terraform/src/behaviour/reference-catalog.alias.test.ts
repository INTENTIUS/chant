/**
 * #5340: the terraform catalog over choudoufu roster nodes.
 *
 * A roster node has `lexicon: "choudoufu"` and the provider type as its
 * `kind`. `aliases: ["choudoufu"]` on the catalog reads those nodes with
 * terraform's rules, through the same `runCatalogPass` and
 * `reconstructIndexedEdges` a terraform member goes through.
 */
import { describe, expect, it } from "vitest";
import type { IRNode } from "@intentius/chant/graph-ir";
import {
  GRAPH_REFS_LEXICON_ALIAS_FLOOR,
  reconstructIdentityEdges,
  reconstructIndexedEdges,
  refRuleId,
} from "@intentius/chant/graph-refs";
import { runCatalogPass } from "@intentius/chant/workspace/catalog-edges";
import { TERRAFORM_REFERENCE_CATALOG } from "./reference-catalog";

const ROSTER = "choudoufu";
const aliased = [{ lexicon: "terraform", catalog: TERRAFORM_REFERENCE_CATALOG, aliases: [ROSTER] }];
const plain = [{ lexicon: "terraform", catalog: TERRAFORM_REFERENCE_CATALOG }];
const scope = () => ({ account: "declared" });

const node = (id: string, kind: string, attrs: Record<string, unknown>, extra: Partial<IRNode> = {}): IRNode => ({ id, kind, lexicon: ROSTER, attrs, ...extra });

/** Roster nodes with block arguments, wired by literal names and ids. */
const roster: IRNode[] = [
  node("loom/aws_vpc.main", "aws_vpc", {}, { physicalId: "vpc-0abc" }),
  node("loom/aws_subnet.a", "aws_subnet", { vpc_id: "vpc-0abc" }),
  node("loom/aws_db_subnet_group.main", "aws_db_subnet_group", { name: "loom-prod-subnet-group", subnet_ids: ["subnet-1"] }),
  node("loom/aws_db_instance.main", "aws_db_instance", { db_subnet_group_name: "loom-prod-subnet-group", identifier: "loom-prod" }),
  node("loom/aws_lambda_function.api", "aws_lambda_function", { function_name: "loom-api" }),
  node("loom/aws_lambda_permission.api", "aws_lambda_permission", { function_name: "loom-api" }),
];

/** The pairs behold's value match gives on `roster`: a node's own-name value found in another node's attribute. */
const VALUE_MATCH_PAIRS = [
  ["loom/aws_db_instance.main", "loom/aws_db_subnet_group.main"],
  ["loom/aws_lambda_permission.api", "loom/aws_lambda_function.api"],
];

describe("a lexicon alias on the terraform catalog (#5340)", () => {
  it("applies no catalog to roster nodes without the alias", () => {
    expect(reconstructIndexedEdges(roster, plain, scope).edges).toEqual([]);
  });

  it("draws the terraform catalog's edges on roster nodes with block arguments", () => {
    const out = reconstructIndexedEdges(roster, aliased, scope);
    expect(out.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "loom/aws_subnet.a", to: "loom/aws_vpc.main", rule: refRuleId("terraform", "aws_subnet", "vpc_id"), relation: "containment", origin: "derived" }),
      ]),
    );
  });

  it("includes every edge behold's value match gives on the same nodes", () => {
    const out = reconstructIndexedEdges(roster, aliased, scope);
    const pairs = out.edges.map((e) => [e.from, e.to]);
    for (const pair of VALUE_MATCH_PAIRS) expect(pairs).toContainEqual(pair);
    expect(out.ambiguous).toEqual([]);
  });

  it("runs through runCatalogPass, with the catalog's own lexicon in each rule id", () => {
    const out = runCatalogPass(roster.map((n) => ({ ...n, member: "loom" })), aliased);
    const pairs = out.edges.map((e) => [e.from, e.to]);
    for (const pair of VALUE_MATCH_PAIRS) expect(pairs).toContainEqual(pair);
    expect(out.edges.every((e) => e.rule?.startsWith("terraform:"))).toBe(true);
    expect(out.lexicons).toEqual(["terraform"]);
  });

  it("leaves a node of another lexicon name alone", () => {
    const other = roster.map((n) => ({ ...n, lexicon: "somethingelse" }));
    expect(reconstructIndexedEdges(other, aliased, scope).edges).toEqual([]);
  });

  it("lets an identity owner name roster nodes too", () => {
    const nodes = [
      node("loom/aws_s3_bucket.a", "aws_s3_bucket", {}, { nativeId: "loom-bucket-name" }),
      { id: "app/Deployment/web", kind: "Deployment", lexicon: "k8s", attrs: { spec: { env: "loom-bucket-name" } } } as IRNode,
    ];
    expect(reconstructIdentityEdges(nodes, [{ lexicon: "terraform" }], scope).edges).toEqual([]);
    const out = reconstructIdentityEdges(nodes, [{ lexicon: "terraform", aliases: [ROSTER] }], scope);
    expect(out.edges.map((e) => [e.from, e.to])).toEqual([["app/Deployment/web", "loom/aws_s3_bucket.a"]]);
  });

  it("exports the floor", () => {
    expect(typeof GRAPH_REFS_LEXICON_ALIAS_FLOOR).toBe("string");
  });
});
