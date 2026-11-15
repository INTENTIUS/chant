import type { IRNode } from "@intentius/chant/graph-ir";
import type { ReferenceCatalog, SharedCatalogNode } from "@intentius/chant/graph-refs";
import { helmChartKey, normalizeChartRepo, HELM_REFERENCES_KEY, HELM_VALUES_KIND, type HelmChartRef } from "@intentius/chant-lexicon-k8s/helm-references";

/**
 * Helm chart nodes on a declared workspace graph (#5100).
 *
 * Four kinds of object name a chart: a kustomization's `helmCharts`, an Argo
 * CD Application or ApplicationSet source, a Flux `HelmRelease`, and a
 * Terraform `helm_release`. One chart named by several of them, in several
 * members, is one node, `Helm::ChartRef`, identified by its repository, name
 * and version. No member owns it, so the catalog pass asks {@link helmSharedNodes}
 * for the nodes and draws an edge to each from every object that names it.
 *
 * What each holder gives:
 *
 * - The k8s reader stamps `helmReferences.charts[]` on a kustomization, an
 *   Application, an ApplicationSet and a HelmRelease (`@intentius/chant-lexicon-k8s/helm-references`).
 * - A `helm_release` is read as the terraform catalog's declared view gives it:
 *   its literal `repository`, `chart` and `version`. A release whose
 *   repository or chart is an interpolation, or that names no repository,
 *   names no chart node.
 * - A `Helm::Values` node, read from a values file, names the charts that
 *   name it, so the edge from a values file to its chart is drawn from it.
 *
 * A Flux release names a `HelmRepository` object, not a URL. The repository's
 * `spec.url` is used when that object is in the graph, and the reference stays
 * `flux:<namespace>/<name>` when it is not, so it joins nothing it cannot be
 * shown to name.
 *
 * Two references are one chart when their repository URL (without a trailing
 * slash), chart name and version, as written, are equal.
 */

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The id suffix, kind and attributes of a chart node. */
export const HELM_CHART_KIND = "Helm::ChartRef";

/** The chart node's own id. */
export function helmChartNodeId(ref: HelmChartRef): string {
  return `chart:${helmChartKey(ref)}`;
}

/** A chart node's attributes: what a reference names. */
export function helmChartAttrs(ref: HelmChartRef): Record<string, unknown> {
  return { repo: ref.repo, chart: ref.chart, ...(ref.version ? { version: ref.version } : {}) };
}

interface Named {
  ref: HelmChartRef;
  from: string;
  via: string;
  label: string;
}

/** The chart references the nodes name, each with the node that names it. */
export function namedCharts(nodes: readonly IRNode[]): Named[] {
  const repoUrls = new Map<string, string>();
  for (const n of nodes) {
    if (n.kind !== "K8s::Flux::HelmRepository") continue;
    const meta = isMap(n.attrs.metadata) ? n.attrs.metadata : {};
    const spec = isMap(n.attrs.spec) ? n.attrs.spec : {};
    const name = str(meta.name);
    const url = str(spec.url);
    if (name && url && !url.includes("{{")) repoUrls.set(`${str(meta.namespace) ?? "default"}/${name}`, normalizeChartRepo(url));
  }

  const out: Named[] = [];
  for (const n of nodes) {
    if (n.lexicon === "k8s") {
      const stamp = isMap(n.attrs[HELM_REFERENCES_KEY]) ? n.attrs[HELM_REFERENCES_KEY] : {};
      for (const c of Array.isArray(stamp.charts) ? stamp.charts : []) {
        if (!isMap(c) || !str(c.repo) || !str(c.chart)) continue;
        const repo = String(c.repo);
        const resolved = repo.startsWith("flux:") ? (repoUrls.get(repo.slice("flux:".length)) ?? repo) : repo;
        out.push({ ref: { repo: resolved, chart: String(c.chart), version: typeof c.version === "string" ? c.version : "" }, from: n.id, via: `${HELM_REFERENCES_KEY}.charts`, label: "chart" });
      }
    } else if (n.kind === "helm_release") {
      const repo = str(n.attrs.repository);
      const chart = str(n.attrs.chart);
      if (!repo || !chart) continue;
      const version = typeof n.attrs.version === "string" ? n.attrs.version : "";
      out.push({ ref: { repo: normalizeChartRepo(repo), chart, version }, from: n.id, via: "chart", label: "chart" });
    } else if (n.kind === HELM_VALUES_KIND && n.lexicon === "helm") {
      for (const c of Array.isArray(n.attrs.charts) ? n.attrs.charts : []) {
        if (!isMap(c) || !str(c.repo) || !str(c.chart)) continue;
        out.push({ ref: { repo: String(c.repo), chart: String(c.chart), version: typeof c.version === "string" ? c.version : "" }, from: n.id, via: "charts", label: "values of" });
      }
    }
  }
  return out;
}

/** One chart node per distinct reference, with the nodes that name it. Pure. */
export function helmSharedNodes(nodes: readonly IRNode[]): SharedCatalogNode[] {
  const byKey = new Map<string, SharedCatalogNode>();
  for (const { ref, from, via, label } of namedCharts(nodes)) {
    const id = helmChartNodeId(ref);
    const node = byKey.get(id) ?? byKey.set(id, { id, kind: HELM_CHART_KIND, attrs: helmChartAttrs(ref), holders: [] }).get(id)!;
    if (!node.holders.some((h) => h.from === from && h.via === via)) node.holders.push({ from, via, label });
  }
  return [...byKey.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const helmReferenceCatalog: ReferenceCatalog = {
  identities: [],
  refs: [],
  sharedNodes: helmSharedNodes,
};
