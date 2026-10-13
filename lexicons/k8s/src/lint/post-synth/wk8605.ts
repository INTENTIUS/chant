/**
 * WK8605: a collector config reads the node, and its workload doesn't give it the node
 *
 * `k8sattributes` filtering to its node by `filter.node_from_env_var`, and
 * `kubeletstats` addressing the kubelet by `${env:K8S_NODE_NAME}`, need that
 * variable set in the pod; unset, the filter matches no pod and the kubelet
 * address doesn't resolve. `hostmetrics` with `root_path` needs the host root
 * mounted there, and `filelog` needs the directories it reads mounted from
 * the host. None of this fails at startup: the collector runs and reports
 * the container instead of the node, or nothing.
 *
 * What a config needs is worked out by `collectorNodeAccess`, the function
 * `OtelCollector` uses to add it (chant #3103), so the composite's own
 * output passes and this fires on hand-written workloads. Only the
 * containers that pass `--config` count (every container when none does). A variable
 * counts as set whatever its source; a mount counts when a hostPath volume
 * covers the path. Whether the container may read root-owned log files is
 * not checked, since that depends on the runtime. One build root at a time
 * (chant #1939).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { docsToManifests, extractContainers, extractPodSpec, type K8sContainer, type K8sManifest } from "./k8s-helpers";
import { collectorPlacements, describePlacement, isOperatorCollector } from "./otel-placement-helpers";
import { collectorNodeAccess, type NodeHostMount } from "../../composites/otel-collector-node";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function within(path: string, dir: string): boolean {
  const d = dir.replace(/\/+$/, "");
  return d === "" || path === d || path.startsWith(`${d}/`);
}

/**
 * The containers that run a collector: those passing `--config`, or every
 * container when none does. A sidecar's variables and mounts don't count.
 */
function collectorContainers(workload: K8sManifest): K8sContainer[] {
  // An OpenTelemetryCollector's `spec.env` and `spec.volumeMounts` are the collector container's own.
  if (isOperatorCollector(workload)) return [{ env: workload.spec?.env as K8sContainer["env"], volumeMounts: workload.spec?.volumeMounts }];
  const all = extractContainers(workload);
  const withConfig = all.filter((c) =>
    [...(Array.isArray(c.command) ? c.command : []), ...(Array.isArray(c.args) ? c.args : [])].some(
      (a) => typeof a === "string" && (a === "--config" || a.startsWith("--config=")),
    ),
  );
  return withConfig.length > 0 ? withConfig : all;
}

/** Each container mount backed by a hostPath volume, as [host path, container path]. */
function hostMounts(workload: K8sManifest, containers: K8sContainer[]): Array<[string, string]> {
  const pod = isOperatorCollector(workload) ? workload.spec : extractPodSpec(workload);
  const hostPaths = new Map<string, string>();
  for (const v of Array.isArray(pod?.volumes) ? pod.volumes : []) {
    if (isRecord(v) && typeof v.name === "string" && isRecord(v.hostPath) && typeof v.hostPath.path === "string") {
      hostPaths.set(v.name, v.hostPath.path);
    }
  }
  const out: Array<[string, string]> = [];
  for (const c of containers) {
    for (const m of Array.isArray(c.volumeMounts) ? c.volumeMounts : []) {
      if (!isRecord(m) || typeof m.name !== "string" || typeof m.mountPath !== "string") continue;
      const host = hostPaths.get(m.name);
      if (host !== undefined) out.push([host.replace(/\/+$/, "") || "/", m.mountPath.replace(/\/+$/, "") || "/"]);
    }
  }
  return out;
}

/** Whether some hostPath mount gives the container the host path a requirement names, at its path. */
function covered(need: NodeHostMount, mounts: Array<[string, string]>): boolean {
  return mounts.some(([host, path]) => {
    // hostmetrics takes the host root or parts of it anywhere at or under root_path.
    if (need.partial && within(path, need.mountPath)) {
      const rel = path.slice(need.mountPath.length);
      return host === (rel || "/");
    }
    if (!within(need.mountPath, path)) return false;
    const rel = need.mountPath.slice(path === "/" ? 0 : path.length);
    const expected = `${host === "/" ? "" : host}${rel}` || "/";
    return expected === need.hostPath;
  });
}

function envNames(containers: K8sContainer[]): Set<string> {
  const names = new Set<string>();
  for (const c of containers) {
    for (const e of Array.isArray(c.env) ? c.env : []) {
      if (isRecord(e) && typeof e.name === "string") names.add(e.name);
    }
  }
  return names;
}

export const wk8605: PostSynthCheck = {
  id: "WK8605",
  description:
    "OpenTelemetry Collector config reads the node (k8sattributes filtered to its node, kubeletstats, hostmetrics root_path, filelog) but its workload doesn't set the node name variable or mount the host paths. Sees one build root at a time (chant #1939).",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const p of collectorPlacements(docsToManifests(ctx))) {
      const need = collectorNodeAccess(p.config);
      if (need.env.length === 0 && need.mounts.length === 0) continue;

      const containers = collectorContainers(p.workload);
      const env = envNames(containers);
      const mounts = hostMounts(p.workload, containers);
      const gaps: string[] = [];
      for (const v of need.env) {
        if (!env.has(v.name)) gaps.push(`no ${v.name} variable (set it from ${v.valueFrom.fieldRef.fieldPath} with the downward API)`);
      }
      for (const m of need.mounts) {
        if (!covered(m, mounts)) gaps.push(`${m.component} reads host ${m.hostPath} at ${m.mountPath}, which no hostPath volume mounts`);
      }
      if (gaps.length === 0) continue;

      diagnostics.push({
        checkId: "WK8605",
        severity: "warning",
        message:
          `${describePlacement(p)} runs a collector config that reads the node (${p.where}), but: ${gaps.join("; ")}. ` +
          `Without them the collector reports on its own container, or nothing. OtelCollector adds these from the config; ` +
          `in a hand-written workload, add them read-only.`,
        entity: p.name,
        lexicon: "k8s",
      });
    }
    return diagnostics;
  },
};
