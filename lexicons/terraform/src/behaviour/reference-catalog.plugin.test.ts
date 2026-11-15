/**
 * #4535: terraform's catalog is on the plugin, and what it reads there.
 *
 * A reader that asks each lexicon of a graph for its catalog (behold#1030)
 * now finds terraform's. On a `chant graph` node (`Terraform::Resource`, no
 * arguments in its attrs) no rule applies, so a declared terraform graph
 * keeps exactly the edges its HCL references give it: on example-three-cloud's
 * azure member that is also what behold's matcher added (nothing). On a node
 * whose kind is the provider type and whose attrs are the block's arguments,
 * each rule draws its edge.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IRNode } from "@intentius/chant/graph-ir";
import { reconstructIndexedEdges, refRuleId } from "@intentius/chant/graph-refs";
import { literalArguments, TERRAFORM_REFERENCE_CATALOG, terraformDeclaredNode } from "./reference-catalog";
import { runCatalogPass } from "@intentius/chant/workspace/catalog-edges";
import { terraformPlugin } from "../plugin";

const LEXICON = "terraform";

function atPath(path: string, value: string): Record<string, unknown> {
  const parts = path.split(".");
  const build = (i: number): unknown => {
    if (i === parts.length) return value;
    const part = parts[i];
    const isArr = part.endsWith("[]");
    const inner = build(i + 1);
    return { [isArr ? part.slice(0, -2) : part]: isArr ? [inner] : inner };
  };
  return build(0) as Record<string, unknown>;
}

describe("terraform reference catalog on the plugin", () => {
  it("is the plugin's referenceCatalog", () => {
    expect(terraformPlugin.referenceCatalog).toBe(TERRAFORM_REFERENCE_CATALOG);
  });

  describe("each targeted rule draws its edge on provider-typed nodes", () => {
    for (const [i, rule] of TERRAFORM_REFERENCE_CATALOG.refs.entries()) {
      // A rule with a `join` spans two values and has its own fixtures (packages/core/src/workspace/identity-annotation-catalog.test.ts).
      if (!rule.targetKind || rule.join) continue;
      it(`${rule.from} ${rule.path} -> ${rule.targetKind}`, () => {
        const value = `id-${i}`;
        const nodes: IRNode[] = [
          { id: `holder-${i}`, kind: rule.from, lexicon: LEXICON, attrs: atPath(rule.path, value) },
          { id: `target-${i}`, kind: rule.targetKind!, lexicon: LEXICON, attrs: {}, physicalId: value },
        ];
        const out = reconstructIndexedEdges(nodes, [{ lexicon: LEXICON, catalog: TERRAFORM_REFERENCE_CATALOG }], () => ({ account: "declared" }));
        expect(out.edges.find((e) => e.from === `holder-${i}` && e.to === `target-${i}`)?.rule).toBe(refRuleId(LEXICON, rule.from, rule.path));
      });
    }
  });

  describe("example-three-cloud's azure member (parity with behold's matcher)", () => {
    const graph = JSON.parse(readFileSync(join(import.meta.dirname, "..", "__fixtures__", "three-cloud-azure.graph.json"), "utf-8")) as { nodes: IRNode[] };
    const out = reconstructIndexedEdges(graph.nodes, [{ lexicon: LEXICON, catalog: TERRAFORM_REFERENCE_CATALOG }], () => ({ account: "declared" }));

    it("adds no edge to a declared block graph, as the matcher added none", () => {
      expect(graph.nodes.some((n) => n.kind === "Terraform::Resource")).toBe(true);
      expect(out.edges).toEqual([]);
      expect(out.ambiguous).toEqual([]);
      expect(out.dangling).toEqual([]);
    });
  });
});

describe("a declared block, as chant workspace graph's catalog pass reads it (#5097)", () => {
  const block = (member: string, address: string, body: Record<string, unknown>) => ({
    id: `${member}/r/${address}`,
    kind: "Terraform::Resource",
    lexicon: LEXICON,
    member,
    attrs: { address, type: address.split(".")[0], name: address.split(".")[1], body, source: "..." },
  });

  it("has the provider type as its kind and its literal arguments as attrs, counting the rest", () => {
    const view = terraformDeclaredNode(block("net", "aws_subnet.a", {
      vpc_id: "vpc-1",
      cidr_block: "${var.cidr}",
      tags: { Name: "a", Env: "${var.env}" },
      ids: ["sg-1", "${aws_security_group.x.id}"],
      ebs_block_device: [{ volume_size: 8, kms_key_id: "${aws_kms_key.k.arn}" }],
    }));
    expect(view).toEqual({
      kind: "aws_subnet",
      attrs: { vpc_id: "vpc-1", tags: { Name: "a" }, ids: ["sg-1"], ebs_block_device: [{ volume_size: 8 }] },
      nonLiteral: 4,
    });
    expect(literalArguments({}).nonLiteral).toBe(0);
    expect(terraformDeclaredNode({ id: "x", kind: "Terraform::Variable", lexicon: LEXICON, attrs: {} })).toBeUndefined();
  });

  it("reads a literal argument with the provider type's rules across members, and counts what it could not read", () => {
    const rule = refRuleId(LEXICON, "aws_subnet", "vpc_id");
    const out = runCatalogPass(
      [
        // The catalog has no identity rules yet, so a node is named by its id here.
        block("net", "aws_subnet.a", { vpc_id: "core/r/aws_vpc.main", cidr_block: "${var.cidr}" }),
        block("net", "aws_subnet.b", { vpc_id: "vpc-0abc" }),
        block("core", "aws_vpc.main", {}),
      ],
      [{ lexicon: LEXICON, catalog: TERRAFORM_REFERENCE_CATALOG }],
    );
    expect(out.edges).toEqual([expect.objectContaining({ from: "net/r/aws_subnet.a", to: "core/r/aws_vpc.main", rule, relation: "containment", member: "net" })]);
    expect(out.dangling).toEqual([expect.objectContaining({ from: "net/r/aws_subnet.b", rule, value: "vpc-0abc", targetKind: "aws_vpc" })]);
    expect(out.nonLiteral).toEqual({ "net/r/aws_subnet.a": 1 });
  });
});

describe("evaluated arguments in the catalog pass (#5117)", () => {
  // Stand-ins for the rules #5099 and #5101 add: an identity that names a
  // cluster and a service account by an argument, and a rule from an Argo CD
  // cluster Secret's name. Only the values come from this lexicon.
  const withIdentities = {
    ...TERRAFORM_REFERENCE_CATALOG,
    identities: [
      { kind: "google_container_cluster", ids: ["name"] },
      { kind: "google_service_account", ids: ["account_id"] },
    ],
  };
  const standIn = {
    identities: [],
    refs: [
      { from: "Secret", path: "stringData.name", targetKind: "google_container_cluster", relation: "reference" as const, label: "cluster" },
      { from: "ConfigMap", path: "data.account", targetKind: "google_service_account", relation: "reference" as const, label: "as" },
    ],
  };

  it("joins a cluster Secret to the cluster instance its count picks by its resolved name, and an instance by its resolved account_id", async () => {
    const { renderTerraformRoots } = await import("../hcl/roots");
    const { buildGraphIr, withInstanceNodes } = await import("@intentius/chant/graph-ir");
    const rendered = await renderTerraformRoots({ projectRoot: join(import.meta.dirname, "..", "__fixtures__", "resolved-arguments"), roots: { bt: { dir: "./build-trusted" } } });
    const ir = withInstanceNodes(buildGraphIr(rendered.entities), rendered.entities);
    const prefix = (id: string) => `infra/${id}`;
    const nodes = [
      ...ir.nodes.map((n) => ({ ...n, id: prefix(n.id), member: "infra", ...(n.instanceOf ? { instanceOf: prefix(n.instanceOf) } : {}) })),
      { id: "apps/Secret/gke-prow-build-trusted", kind: "Secret", lexicon: "k8s", member: "apps", attrs: { stringData: { name: "prow-build-trusted" } } },
      { id: "apps/ConfigMap/sa", kind: "ConfigMap", lexicon: "k8s", member: "apps", attrs: { data: { account: "gcb-builder" } } },
    ];
    const out = runCatalogPass(nodes, [
      { lexicon: LEXICON, catalog: withIdentities },
      { lexicon: "k8s", catalog: standIn },
    ]);
    // The module's prod and test blocks share a name; `count = var.is_prod_cluster == "true" ? 1 : 0` plans only the prod one (#5094).
    expect(out.ambiguous).toEqual([]);
    expect(out.edges.map((e) => [e.from, e.to])).toEqual(expect.arrayContaining([
      ["apps/Secret/gke-prow-build-trusted", "infra/bt/module.prow_build_cluster/google_container_cluster.prod_cluster[0]"],
      ["apps/ConfigMap/sa", 'infra/bt/module.workload_identity_service_accounts["gcb-builder"]/google_service_account.serviceaccount'],
    ]));
    // What stays unread: the data source, timestamp() and the computed email in extras.tf among them.
    expect(out.nonLiteral["infra/bt/google_storage_bucket.from_data"]).toBe(1);
    expect(out.nonLiteral["infra/bt/google_storage_bucket.dated"]).toBe(1);
    expect(out.nonLiteral["infra/bt/google_project_iam_member.computed"]).toBe(1);
  });

  it("reads an instance node with no evaluated entry on its block as it is", () => {
    const blockNode: IRNode = { id: "m/r/aws_eip.pool", kind: "Terraform::Resource", lexicon: LEXICON, attrs: { address: "aws_eip.pool", type: "aws_eip", body: { domain: "vpc" } } };
    const inst: IRNode = { id: "m/r/aws_eip.pool[0]", kind: "Terraform::Resource", lexicon: LEXICON, attrs: {}, instanceOf: blockNode.id, instanceKey: "[0]" };
    expect(terraformDeclaredNode(inst, blockNode)).toBeUndefined();
    expect(terraformDeclaredNode(blockNode)).toEqual({ kind: "aws_eip", attrs: { domain: "vpc" }, nonLiteral: 0 });
  });
});
