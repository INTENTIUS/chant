import { describe, expect, test } from "vitest";
import type { IRNode } from "@intentius/chant/graph-ir";
import { helmChartNodeId, helmSharedNodes } from "./reference-catalog";

const node = (id: string, lexicon: string, kind: string, attrs: Record<string, unknown>): IRNode => ({ id, lexicon, kind, attrs });

describe("helmSharedNodes", () => {
  const stamp = (charts: unknown[]) => ({ helmReferences: { charts, valuesFiles: [] } });

  test("one node for a chart named by a kustomization, a release and a values file", () => {
    const nodes = [
      node("k/kustomization", "k8s", "K8s::Kustomize::Kustomization", stamp([{ repo: "https://h.example.com", chart: "c", version: "1" }])),
      node("t/helm_release.c", "terraform", "helm_release", { repository: "https://h.example.com/", chart: "c", version: "1" }),
      node("k/values", "helm", "Helm::Values", { path: "v.yaml", charts: [{ repo: "https://h.example.com", chart: "c", version: "1" }] }),
    ];
    const out = helmSharedNodes(nodes);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(helmChartNodeId({ repo: "https://h.example.com", chart: "c", version: "1" }));
    expect(out[0].holders.map((h) => [h.from, h.via])).toEqual([
      ["k/kustomization", "helmReferences.charts"],
      ["t/helm_release.c", "chart"],
      ["k/values", "charts"],
    ]);
  });

  test("versions and repositories make different nodes", () => {
    const nodes = [
      node("a", "k8s", "K8s::Argo::Application", stamp([{ repo: "https://h.example.com", chart: "c", version: "1" }, { repo: "https://h.example.com", chart: "c", version: "2" }, { repo: "https://other.example.com", chart: "c", version: "1" }])),
    ];
    expect(helmSharedNodes(nodes).map((n) => n.id)).toEqual(["chart:h.example.com/c@1", "chart:h.example.com/c@2", "chart:other.example.com/c@1"]);
  });

  test("a release with no repository, or no literal chart, names no chart", () => {
    expect(helmSharedNodes([node("t/a", "terraform", "helm_release", { chart: "c" }), node("t/b", "terraform", "helm_release", { repository: "https://h.example.com" })])).toEqual([]);
  });

  test("a Flux release takes its HelmRepository's URL when the object is in the graph, and joins nothing otherwise", () => {
    const release = (ns: string) => node(`r-${ns}`, "k8s", "K8s::Flux::HelmRelease", stamp([{ repo: `flux:${ns}/repo`, chart: "c", version: "1" }]));
    const repository = node("repo", "k8s", "K8s::Flux::HelmRepository", { metadata: { name: "repo", namespace: "flux-system" }, spec: { url: "https://h.example.com/" } });
    const out = helmSharedNodes([release("flux-system"), release("apps"), repository]);
    expect(out.map((n) => [n.id, n.holders.map((h) => h.from)])).toEqual([
      ["chart:flux:apps/repo/c@1", ["r-apps"]],
      ["chart:h.example.com/c@1", ["r-flux-system"]],
    ]);
  });
});
