/**
 * Reference resolution and the graph IR it feeds (chant #2265, #2266).
 *
 * Everything here goes through `renderTerraformRoots` and then core's own
 * `buildGraphIr`, which is the exact pair `chant graph --format ir` runs, so
 * what is asserted is what a renderer receives. The fixture is
 * `src/__fixtures__/graph-roots/`: two roots, a local child module, and one
 * instance of every decision these issues asked to have pinned.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildGraphIr, entityReferences, entityStack, type IREdge } from "@intentius/chant/graph-ir";
import type { Declarable } from "@intentius/chant/declarable";
import { renderTerraformRoots } from "./roots";
import { referenceFromAccessor } from "./edges";
import type { TerraformEntity } from "./parse";

const TREE = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__", "graph-roots");

let entities: Map<string, Declarable>;
let edges: IREdge[];
let groups: ReturnType<typeof buildGraphIr>["groups"];

beforeAll(async () => {
  const rendered = await renderTerraformRoots({
    projectRoot: TREE,
    roots: { app: { dir: "./app" }, network: { dir: "./network" } },
  });
  expect(rendered.warnings).toEqual([]);
  entities = rendered.entities;
  const ir = buildGraphIr(entities);
  edges = ir.edges;
  groups = ir.groups;
});

/** The edge between two nodes through one consumer attribute, if there is one. */
function edge(from: string, to: string, viaAttr: string): IREdge | undefined {
  return edges.find((e) => e.from === from && e.to === to && e.viaAttr === viaAttr);
}

describe("referenceFromAccessor", () => {
  it("classifies every form that becomes an edge", () => {
    expect(referenceFromAccessor("aws_vpc.main.id")).toEqual({ address: "aws_vpc.main", attr: "id" });
    expect(referenceFromAccessor("module.cdn.url")).toEqual({ address: "module.cdn", attr: "url" });
    expect(referenceFromAccessor("data.aws_ami.ubuntu.id")).toEqual({
      address: "data.aws_ami.ubuntu",
      attr: "id",
    });
    expect(referenceFromAccessor("var.region")).toEqual({ address: "var.region" });
    expect(referenceFromAccessor("local.tags")).toEqual({ address: "local.tags" });
  });

  it("reads no reference out of the meta-arguments that are not one", () => {
    // `count.index`, `each.value`, `path.module`, `terraform.workspace` and
    // `self.x` all look like `<head>.<name>` and none of them names a block.
    expect(referenceFromAccessor("count.index")).toBeUndefined();
    expect(referenceFromAccessor("each.value")).toBeUndefined();
    expect(referenceFromAccessor("path.module")).toBeUndefined();
    expect(referenceFromAccessor("terraform.workspace")).toBeUndefined();
    expect(referenceFromAccessor("self.private_ip")).toBeUndefined();
  });
});

describe("edges out of a parsed estate (#2265)", () => {
  it("emits the whole edge set, and only it", () => {
    expect(
      edges.map((e) => [e.from, e.to, e.viaAttr ?? "", e.toAttr ?? ""].join(" ")),
    ).toEqual([
      "app/aws_instance.web app/aws_s3_bucket.assets depends_on ",
      "app/aws_instance.web app/data.aws_iam_policy.boundary tags arn",
      "app/aws_instance.web app/module.cdn depends_on ",
      "app/aws_instance.web app/var.subnets count ",
      "app/aws_instance.web app/var.subnets subnet_id ",
      "app/module.cdn/aws_cloudfront_distribution.cdn app/module.cdn/var.bucket origin_id ",
      "app/module.cdn app/aws_s3_bucket.assets bucket id",
      "app/output.cdn_url app/module.cdn value url",
      "app/provider.aws app/var.region region ",
      "network/aws_vpc.main network/locals tags ",
      "network/aws_vpc.main network/var.cidr cidr_block ",
      "network/output.vpc_id network/aws_vpc.main value id",
    ]);
  });

  it("makes a `module` reference an edge to the call block, in both directions of use", () => {
    // The call reads a resource; an output reads the call.
    expect(edge("app/module.cdn", "app/aws_s3_bucket.assets", "bucket")).toEqual({
      from: "app/module.cdn",
      to: "app/aws_s3_bucket.assets",
      kind: "ref",
      viaAttr: "bucket",
      toAttr: "id",
    });
    expect(edge("app/output.cdn_url", "app/module.cdn", "value")?.toAttr).toBe("url");
  });

  it("makes `depends_on` an edge with no producer attribute", () => {
    const ordering = edges.filter((e) => e.viaAttr === "depends_on");
    expect(ordering.map((e) => e.to).sort()).toEqual(["app/aws_s3_bucket.assets", "app/module.cdn"]);
    for (const e of ordering) expect(e.toAttr).toBeUndefined();
  });

  it("keeps a `count` block one node, and its edges block-to-block", () => {
    const web = entities.get("app/aws_instance.web") as TerraformEntity;
    // `count = length(var.subnets)` over a list: the declaration is one block,
    // so it is one node whatever the count evaluates to, and the expansion is
    // recorded rather than left to be inferred from a node count.
    expect(web.props.expansion).toBe("count");
    expect([...entities.keys()].filter((k) => k.startsWith("app/aws_instance.web"))).toEqual([
      "app/aws_instance.web",
    ]);
    // The meta-argument is an expression like any other, so it carries an edge.
    expect(edge("app/aws_instance.web", "app/var.subnets", "count")).toBeDefined();
    // ...and reading `var.subnets[count.index]` elsewhere in the block is a
    // second edge through a second attribute, not a second instance.
    expect(edge("app/aws_instance.web", "app/var.subnets", "subnet_id")).toBeDefined();
  });

  it("makes `var` and `local` edges, and resolves a local to the block that declares it", () => {
    expect(edge("network/aws_vpc.main", "network/var.cidr", "cidr_block")).toBeDefined();
    expect(edge("network/aws_vpc.main", "network/locals", "tags")).toBeDefined();
  });

  it("names the consumer attribute on every edge and the producer attribute only when one was read", () => {
    for (const e of edges) expect(e.viaAttr).toBeTruthy();
    // `data.aws_iam_policy.boundary.arn` named exactly one producer attribute.
    expect(edge("app/aws_instance.web", "app/data.aws_iam_policy.boundary", "tags")?.toAttr).toBe("arn");
    // `[aws_s3_bucket.assets]` named none.
    expect(edge("app/aws_instance.web", "app/aws_s3_bucket.assets", "depends_on")?.toAttr).toBeUndefined();
  });

  it("resolves a child module's references inside the child's own scope", () => {
    // `var.bucket` in `module.cdn` is the CHILD's variable. The root declares
    // no `var.bucket` at all, so a scope-blind resolution would have produced
    // no edge here rather than the wrong one; the assertion that matters is
    // that the edge lands on the child's key.
    expect(
      edge(
        "app/module.cdn/aws_cloudfront_distribution.cdn",
        "app/module.cdn/var.bucket",
        "origin_id",
      ),
    ).toBeDefined();
  });

  it("draws no edge for a `provider` meta-argument", () => {
    // `provider = aws.replica` names a block by type AND alias, which this
    // lexicon's `provider.<type>` key cannot be resolved to without guessing.
    expect(edges.some((e) => e.viaAttr === "provider")).toBe(false);
  });

  it("draws no edge between two roots", () => {
    const rootOf = (id: string): string => id.split("/")[0];
    for (const e of edges) expect(rootOf(e.from)).toBe(rootOf(e.to));
  });

  it("publishes the references on the entity, in core's lexicon-neutral shape", () => {
    // The channel core reads (#2265): an entity key, plus the two attribute
    // names `IREdge` carries. Nothing terraform-shaped crosses the boundary.
    expect(entityReferences(entities.get("app/output.cdn_url")!)).toEqual([
      { to: "app/module.cdn", viaAttr: "value", toAttr: "url" },
    ]);
    // An entity that references nothing carries no channel at all.
    expect(entityReferences(entities.get("app/var.region")!)).toEqual([]);
  });

  it("drops a reference to something outside the graph rather than dangling it", () => {
    // Only ids that are nodes become edges, so an entity key that never made
    // it into the IR cannot leave a half-edge behind.
    const ids = new Set([...entities.keys()]);
    for (const e of edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });
});

describe("grouping by root (#2266)", () => {
  it("keys byStack by root name, one entry per declared root", () => {
    expect(Object.keys(groups.byStack ?? {})).toEqual(["app", "network"]);
    expect(groups.byStack?.["network"]).toEqual([
      "network/aws_vpc.main",
      "network/locals",
      "network/output.vpc_id",
      "network/var.cidr",
    ]);
  });

  it("keeps byLexicon saying terraform", () => {
    expect(Object.keys(groups.byLexicon ?? {})).toEqual(["terraform"]);
    expect(groups.byLexicon?.["terraform"].length).toBe(
      (groups.byStack?.["app"].length ?? 0) + (groups.byStack?.["network"].length ?? 0),
    );
  });

  it("puts every node in exactly one root's bucket, the one its id is prefixed with", () => {
    for (const [root, ids] of Object.entries(groups.byStack ?? {})) {
      for (const id of ids) expect(id.startsWith(`${root}/`)).toBe(true);
    }
  });

  it("says which unit an entity belongs to on the entity, not by convention on its id", () => {
    expect(entityStack(entities.get("app/module.cdn/var.bucket")!)).toBe("app");
    expect(entityStack(entities.get("network/aws_vpc.main")!)).toBe("network");
  });
});
