/**
 * WK8704: a ServiceMonitor or PodMonitor that selects no Service or pod, or names a port that is not there
 *
 * A ServiceMonitor's `selector` picks Services (in its own namespace, the
 * `namespaceSelector.matchNames` ones, or every namespace with `any: true`),
 * and each `endpoints[].port` names a port on them. A PodMonitor's `selector`
 * picks pods, and each `podMetricsEndpoints[].port` names a container port.
 * When nothing matches, or the port name is on none of the matches, Prometheus
 * scrapes nothing and says nothing. This check needs no Prometheus in the
 * build: it reads the monitor against the Services and workloads declared
 * beside it.
 *
 * Pods come from the pod templates of Deployment, StatefulSet, DaemonSet, Job
 * and CronJob, and from Pods themselves. An empty `selector` ({}) matches
 * everything, as the operator does. Only a port given by name is checked;
 * `targetPort` and `portNumber` are left alone. One build root at a time
 * (chant #1939): a Service or workload installed from another root is not seen.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { extractContainers, type K8sManifest } from "./k8s-helpers";
import { describe, labelsOf, matchLabelSelector, monitoringKind, nameOf, namespaceOf, selectionContext } from "./monitoring-selection-helpers";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Whether a monitor looks in this namespace: its own, `matchNames`, or all of them with `any`. */
function reaches(monitor: K8sManifest, namespace: string): boolean {
  const ns = (monitor.spec as Record<string, unknown> | undefined)?.namespaceSelector;
  if (isRecord(ns)) {
    if (ns.any === true) return true;
    if (Array.isArray(ns.matchNames) && ns.matchNames.length > 0) return ns.matchNames.includes(namespace);
  }
  return namespaceOf(monitor) === namespace;
}

/** The labels a pod from this workload carries, and its manifest to read ports from. */
function podsOf(manifests: K8sManifest[]): Array<{ manifest: K8sManifest; labels: Record<string, string> }> {
  const out: Array<{ manifest: K8sManifest; labels: Record<string, string> }> = [];
  for (const m of manifests) {
    const spec = (m.spec ?? {}) as Record<string, any>;
    if (m.kind === "Pod") {
      out.push({ manifest: m, labels: labelsOf(m) });
    } else if (m.kind === "Deployment" || m.kind === "StatefulSet" || m.kind === "DaemonSet" || m.kind === "Job") {
      out.push({ manifest: m, labels: labelsOf({ metadata: spec.template?.metadata } as K8sManifest) });
    } else if (m.kind === "CronJob") {
      out.push({ manifest: m, labels: labelsOf({ metadata: spec.jobTemplate?.spec?.template?.metadata } as K8sManifest) });
    }
  }
  return out;
}

function containerPortNames(workload: K8sManifest): Set<string> {
  const names = new Set<string>();
  for (const c of extractContainers(workload)) {
    for (const p of Array.isArray(c.ports) ? c.ports : []) {
      if (isRecord(p) && typeof p.name === "string") names.add(p.name);
    }
  }
  return names;
}

function servicePortNames(service: K8sManifest): Set<string> {
  const names = new Set<string>();
  const ports = (service.spec as Record<string, unknown> | undefined)?.ports;
  for (const p of Array.isArray(ports) ? ports : []) {
    if (isRecord(p) && typeof p.name === "string") names.add(p.name);
  }
  return names;
}

export const wk8704: PostSynthCheck = {
  id: "WK8704",
  description:
    "A ServiceMonitor whose selector matches no Service in the build, or whose endpoints[].port names no port on the matched Services; the same for a PodMonitor against pod container ports. Needs no Prometheus in the build. Sees one build root at a time (chant #1939).",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const { manifests } = selectionContext(ctx);
    const out: PostSynthDiagnostic[] = [];
    const diag = (m: K8sManifest, message: string): PostSynthDiagnostic => ({
      checkId: "WK8704",
      severity: "warning",
      message,
      entity: nameOf(m),
      lexicon: "k8s",
    });

    const services = manifests.filter((m) => m.kind === "Service" && (m.apiVersion === "v1" || m.apiVersion === undefined));
    for (const sm of monitoringKind(manifests, "ServiceMonitor")) {
      const spec = (sm.spec ?? {}) as Record<string, unknown>;
      // A ServiceMonitor's selector is required; treat a missing one like {}.
      const selector = isRecord(spec.selector) ? spec.selector : {};
      const matched = services.filter((s) => reaches(sm, namespaceOf(s)) && matchLabelSelector(selector, labelsOf(s)) !== "no");
      if (matched.length === 0) {
        out.push(diag(sm, `${describe(sm)} has a selector that matches no Service in this build (looking in ${where(sm)}), so Prometheus scrapes nothing for it. Make spec.selector match the labels on the Service, or fix namespaceSelector.`));
        continue;
      }
      const known = new Set<string>();
      for (const s of matched) for (const n of servicePortNames(s)) known.add(n);
      for (const e of Array.isArray(spec.endpoints) ? spec.endpoints : []) {
        if (!isRecord(e) || typeof e.port !== "string" || known.has(e.port)) continue;
        out.push(diag(sm, `${describe(sm)} scrapes endpoint port "${e.port}", but the Service(s) it selects (${matched.map(nameOf).join(", ")}) declare no port with that name${known.size > 0 ? ` (they have: ${[...known].join(", ")})` : ""}. Name the Service port, or point the endpoint at an existing one.`));
      }
    }

    const pods = podsOf(manifests);
    for (const pm of monitoringKind(manifests, "PodMonitor")) {
      const spec = (pm.spec ?? {}) as Record<string, unknown>;
      const selector = isRecord(spec.selector) ? spec.selector : {};
      const matched = pods.filter((p) => reaches(pm, namespaceOf(p.manifest)) && matchLabelSelector(selector, p.labels) !== "no");
      if (matched.length === 0) {
        out.push(diag(pm, `${describe(pm)} has a selector that matches no pod in this build (looking in ${where(pm)}), so Prometheus scrapes nothing for it. Make spec.selector match the pod template labels, or fix namespaceSelector.`));
        continue;
      }
      const known = new Set<string>();
      for (const p of matched) for (const n of containerPortNames(p.manifest)) known.add(n);
      for (const e of Array.isArray(spec.podMetricsEndpoints) ? spec.podMetricsEndpoints : []) {
        if (!isRecord(e) || typeof e.port !== "string" || known.has(e.port)) continue;
        out.push(diag(pm, `${describe(pm)} scrapes container port "${e.port}", but the pods it selects (${matched.map((p) => nameOf(p.manifest)).join(", ")}) declare no container port with that name${known.size > 0 ? ` (they have: ${[...known].join(", ")})` : ""}. Name the container port, or point the endpoint at an existing one.`));
      }
    }
    return out;
  },
};

function where(m: K8sManifest): string {
  const ns = (m.spec as Record<string, unknown> | undefined)?.namespaceSelector;
  if (isRecord(ns)) {
    if (ns.any === true) return "every namespace";
    if (Array.isArray(ns.matchNames) && ns.matchNames.length > 0) return `namespace ${ns.matchNames.join(", ")}`;
  }
  return `namespace ${namespaceOf(m)}`;
}
