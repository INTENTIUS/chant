/**
 * Shared plumbing for the Prometheus Operator selection checks (WK8701-WK8705).
 *
 * An operator accepts a PrometheusRule, monitor or AlertmanagerConfig that no
 * Prometheus or Alertmanager selects and then ignores it without an error.
 * These helpers decide, from the manifests in one build, whether a selector
 * picks an object, following the operator's rules for a label selector:
 *
 *   - an object selector that is null (or absent) matches nothing, `{}` matches all;
 *   - a namespace selector that is null (or absent) matches only the selecting
 *     resource's own namespace, `{}` matches every namespace.
 *
 * Namespace labels come from the Namespace manifests in the build, plus the
 * `kubernetes.io/metadata.name` label every namespace carries. A selector on a
 * label the build cannot know (the namespace is not declared in it) answers
 * "unknown", and the checks stay silent on "unknown".
 */

import { docsToManifests, type K8sManifest } from "./k8s-helpers";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";

export const MONITORING_GROUP = "monitoring.coreos.com/";

export type Match = "yes" | "no" | "unknown";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A manifest of a monitoring.coreos.com kind, whatever the version. */
export function ofMonitoringKind(m: K8sManifest, kind: string): boolean {
  return m.kind === kind && typeof m.apiVersion === "string" && m.apiVersion.startsWith(MONITORING_GROUP);
}

export function monitoringKind(manifests: K8sManifest[], kind: string): K8sManifest[] {
  return manifests.filter((m) => ofMonitoringKind(m, kind));
}

export function namespaceOf(m: K8sManifest): string {
  return typeof m.metadata?.namespace === "string" && m.metadata.namespace !== "" ? m.metadata.namespace : "default";
}

export function nameOf(m: K8sManifest): string {
  return typeof m.metadata?.name === "string" ? m.metadata.name : "";
}

export function describe(m: K8sManifest): string {
  return `${m.kind} ${namespaceOf(m)}/${nameOf(m)}`;
}

/**
 * Whether a label selector matches a label set. Null, undefined and anything
 * that is not an object match nothing; `{}` matches everything.
 * `unknownKeys` are label keys the caller cannot read (a namespace the build
 * does not declare); a requirement on one answers "unknown".
 */
export function matchLabelSelector(selector: unknown, labels: Record<string, string>, unknownKeys: ReadonlySet<string> = new Set()): Match {
  if (!isRecord(selector)) return "no";
  let unknown = false;
  const matchLabels = isRecord(selector.matchLabels) ? selector.matchLabels : {};
  for (const [k, v] of Object.entries(matchLabels)) {
    if (unknownKeys.has(k)) {
      unknown = true;
    } else if (labels[k] !== String(v)) {
      return "no";
    }
  }
  const exprs = Array.isArray(selector.matchExpressions) ? selector.matchExpressions : [];
  for (const e of exprs) {
    if (!isRecord(e) || typeof e.key !== "string") continue;
    if (unknownKeys.has(e.key)) {
      unknown = true;
      continue;
    }
    const values = Array.isArray(e.values) ? e.values.map(String) : [];
    const has = Object.prototype.hasOwnProperty.call(labels, e.key);
    switch (e.operator) {
      case "In":
        if (!has || !values.includes(labels[e.key])) return "no";
        break;
      case "NotIn":
        if (has && values.includes(labels[e.key])) return "no";
        break;
      case "Exists":
        if (!has) return "no";
        break;
      case "DoesNotExist":
        if (has) return "no";
        break;
    }
  }
  return unknown ? "unknown" : "yes";
}

export function labelsOf(m: K8sManifest): Record<string, string> {
  const out: Record<string, string> = {};
  const labels = m.metadata?.labels;
  if (isRecord(labels)) for (const [k, v] of Object.entries(labels)) out[k] = String(v);
  return out;
}

/** The namespaces a build declares, with their labels. */
function declaredNamespaces(manifests: K8sManifest[]): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const m of manifests) {
    if (m.kind === "Namespace" && (m.apiVersion === "v1" || m.apiVersion === undefined) && nameOf(m)) {
      out.set(nameOf(m), { ...labelsOf(m), "kubernetes.io/metadata.name": nameOf(m) });
    }
  }
  return out;
}

/**
 * Whether a selecting resource's namespace selector picks `targetNamespace`.
 * Null or absent: the selecting resource's own namespace only.
 */
export function matchNamespaceSelector(
  selector: unknown,
  ownNamespace: string,
  targetNamespace: string,
  namespaces: Map<string, Record<string, string>>,
): Match {
  if (!isRecord(selector)) return ownNamespace === targetNamespace ? "yes" : "no";
  const declared = namespaces.get(targetNamespace);
  const labels = declared ?? { "kubernetes.io/metadata.name": targetNamespace };
  // A namespace the build does not declare has labels the build cannot know, except the name label.
  const unknownKeys = new Set<string>();
  if (!declared) {
    const keys = [
      ...Object.keys(isRecord(selector.matchLabels) ? selector.matchLabels : {}),
      ...(Array.isArray(selector.matchExpressions) ? selector.matchExpressions : []).map((e) => (isRecord(e) ? String(e.key) : "")),
    ];
    for (const k of keys) if (k !== "kubernetes.io/metadata.name") unknownKeys.add(k);
  }
  return matchLabelSelector(selector, labels, unknownKeys);
}

/** A selecting resource's reach over one object: its object selector, then its namespace selector. */
export function selects(
  selector: unknown,
  namespaceSelector: unknown,
  selecting: K8sManifest,
  object: K8sManifest,
  namespaces: Map<string, Record<string, string>>,
): Match {
  const ns = matchNamespaceSelector(namespaceSelector, namespaceOf(selecting), namespaceOf(object), namespaces);
  if (ns === "no") return "no";
  const obj = matchLabelSelector(selector, labelsOf(object));
  if (obj === "no") return "no";
  return ns === "unknown" || obj === "unknown" ? "unknown" : "yes";
}

export interface SelectionContext {
  manifests: K8sManifest[];
  namespaces: Map<string, Record<string, string>>;
}

export function selectionContext(ctx: PostSynthContext): SelectionContext {
  const manifests = docsToManifests(ctx);
  return { manifests, namespaces: declaredNamespaces(manifests) };
}

/**
 * Objects of `kinds` that no resource in `selectors` selects, by the named
 * object selector and namespace selector fields of each selector's spec.
 * Silent (empty) when `selectors` is empty, since the stack is often installed
 * separately. A selector that answers "unknown" counts as selecting.
 */
export function unselected(
  sc: SelectionContext,
  objects: K8sManifest[],
  selectors: K8sManifest[],
  fields: (selecting: K8sManifest, object: K8sManifest) => [string, string] | null,
): K8sManifest[] {
  if (selectors.length === 0) return [];
  return objects.filter((object) => {
    for (const sel of selectors) {
      const f = fields(sel, object);
      if (!f) continue;
      const spec = (sel.spec ?? {}) as Record<string, unknown>;
      if (selects(spec[f[0]], spec[f[1]], sel, object, sc.namespaces) !== "no") return false;
    }
    return true;
  });
}
