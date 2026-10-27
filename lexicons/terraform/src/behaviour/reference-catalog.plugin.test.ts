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
import { TERRAFORM_REFERENCE_CATALOG } from "./reference-catalog";
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
      if (!rule.targetKind) continue;
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
