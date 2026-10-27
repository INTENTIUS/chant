/**
 * #4535: the gcp reference catalog. Each rule draws its edge on a fixture of
 * its own, the catalog keeps behold#1023's ruling (typed rules, no edge on
 * ambiguity), and on example-three-cloud's gcp member it draws the two edges
 * behold's matcher (behold src/value-match.ts) drew there.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IRNode } from "@intentius/chant/graph-ir";
import { reconstructIndexedEdges, refRuleId, type ReferenceCatalog } from "@intentius/chant/graph-refs";
import { gcpReferenceCatalog } from "./reference-catalog";
import { gcpPlugin } from "./plugin";

const LEXICON = "gcp";
const ONE_SCOPE = () => ({ account: "gcp/three-cloud" });

/** attrs with `value` written at a catalog path (`a.b`, `arr[].c`). */
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

/** A node of `kind` named `value` by the catalog's first identity path for it, else by its native id. */
function target(catalog: ReferenceCatalog, kind: string, id: string, value: string): IRNode {
  const path = catalog.identities.find((r) => r.kind === kind)?.ids[0];
  const lexicon = kind.startsWith("AWS::") ? "aws" : LEXICON;
  return path ? { id, kind, lexicon, attrs: atPath(path, value) } : { id, kind, lexicon, attrs: {}, nativeId: value };
}

describe("gcp reference catalog", () => {
  it("is the plugin's referenceCatalog", () => {
    expect(gcpPlugin.referenceCatalog).toBe(gcpReferenceCatalog);
  });

  it("names a target kind on every rule (behold#1023's ruling)", () => {
    expect(gcpReferenceCatalog.refs.filter((r) => !(r.targetKind ?? r.indexedTargetKind))).toEqual([]);
  });

  it("has no two rules for one holder kind, path and target kind", () => {
    const keys = gcpReferenceCatalog.refs.map((r) => `${r.from}|${r.path}|${r.targetKind}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  describe("each rule draws its edge", () => {
    for (const [i, rule] of gcpReferenceCatalog.refs.entries()) {
      const to = rule.targetKind ?? rule.indexedTargetKind!;
      it(`${rule.from} ${rule.path} -> ${to}`, () => {
        const value = `three-cloud-target-${i}`;
        const holder: IRNode = { id: `holder-${i}`, kind: rule.from, lexicon: LEXICON, attrs: atPath(rule.path, value) };
        const out = reconstructIndexedEdges([holder, target(gcpReferenceCatalog, to, `target-${i}`, value)], [{ lexicon: LEXICON, catalog: gcpReferenceCatalog }], ONE_SCOPE);
        const edge = out.edges.find((e) => e.from === holder.id && e.to === `target-${i}`);
        expect(edge?.rule).toBe(refRuleId(LEXICON, rule.from, rule.path));
        expect(edge?.relation).toBe(rule.relation);
        expect(out.ambiguous).toEqual([]);
      });
    }
  });

  it("joins a name only to a node of the field's kind", () => {
    // A network and a service account share a name; the subnet's networkRef
    // names the network, and the service account is not a candidate.
    const nodes: IRNode[] = [
      { id: "subnet", kind: "GCP::Compute::Subnetwork", lexicon: LEXICON, attrs: { networkRef: { name: "shared" } } },
      { id: "vpc", kind: "GCP::Compute::Network", lexicon: LEXICON, attrs: { metadata: { name: "shared" } } },
      { id: "sa", kind: "GCP::Iam::ServiceAccount", lexicon: LEXICON, attrs: { metadata: { name: "shared" } } },
    ];
    const out = reconstructIndexedEdges(nodes, [{ lexicon: LEXICON, catalog: gcpReferenceCatalog }], ONE_SCOPE);
    expect(out.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["subnet->vpc"]);
  });

  it("draws no edge when two nodes of the kind carry the name, and records both", () => {
    const nodes: IRNode[] = [
      { id: "subnet", kind: "GCP::Compute::Subnetwork", lexicon: LEXICON, attrs: { networkRef: { name: "vpc" } } },
      { id: "vpc-a", kind: "GCP::Compute::Network", lexicon: LEXICON, attrs: { metadata: { name: "vpc" } } },
      { id: "vpc-b", kind: "GCP::Compute::Network", lexicon: LEXICON, attrs: { metadata: { name: "vpc" } } },
    ];
    const out = reconstructIndexedEdges(nodes, [{ lexicon: LEXICON, catalog: gcpReferenceCatalog }], ONE_SCOPE);
    expect(out.edges).toEqual([]);
    expect(out.ambiguous.map((a) => a.candidates)).toEqual([["vpc-a", "vpc-b"]]);
  });

  it("reports nothing dangling for a multi-kind field whose value names a node of one of its kinds", () => {
    const nodes: IRNode[] = [
      { id: "member", kind: "GCP::Iam::PolicyMember", lexicon: LEXICON, attrs: { resourceRef: { kind: "StorageBucket", name: "assets" } } },
      { id: "bucket", kind: "GCP::Storage::Bucket", lexicon: LEXICON, attrs: { metadata: { name: "assets" } } },
    ];
    const out = reconstructIndexedEdges(nodes, [{ lexicon: LEXICON, catalog: gcpReferenceCatalog }], ONE_SCOPE);
    expect(out.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["member->bucket"]);
    expect(out.dangling).toEqual([]);
  });

  describe("example-three-cloud's gcp member (parity with behold's matcher)", () => {
    const graph = JSON.parse(readFileSync(join(import.meta.dirname, "testdata", "three-cloud", "gcp.graph.json"), "utf-8")) as {
      nodes: IRNode[];
      edges: Array<{ from: string; to: string }>;
    };
    const out = reconstructIndexedEdges(graph.nodes, [{ lexicon: LEXICON, catalog: gcpReferenceCatalog }], () => ({ account: "declared" }));
    const declared = new Set(graph.edges.map((e) => `${e.from}->${e.to}`));

    it("draws the two edges the matcher drew, and none the declaration lacks besides", () => {
      const fresh = out.edges.filter((e) => !declared.has(`${e.from}->${e.to}`)).map((e) => `${e.from} -> ${e.to} (${e.rule})`);
      expect(fresh).toEqual([
        "gcp/webPublicAccess -> gcp/webService (gcp:GCP::Iam::PolicyMember:resourceRef.name)",
        "gcp/webService -> gcp/webRuntime (gcp:GCP::Run::Service:template.serviceAccountRef.name)",
      ]);
    });

    it("leaves nothing ambiguous or dangling", () => {
      expect(out.ambiguous).toEqual([]);
      expect(out.dangling).toEqual([]);
    });
  });
});
