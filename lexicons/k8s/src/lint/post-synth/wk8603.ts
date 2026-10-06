/**
 * WK8603: `k8s_cluster` receiver in a collector that runs more than one copy
 * without a leader elector
 *
 * The `k8s_cluster` receiver reports cluster-level metrics and entity events
 * (nodes, deployments, pods, resource quotas) by watching the API server.
 * Every copy of the collector reports every object, so in a DaemonSet the
 * cluster is reported once per node, and in a Deployment once per replica:
 * duplicated series and N watches against the API server. Run it in a
 * single-replica Deployment, or set the receiver's `k8s_leader_elector` to a
 * `k8s_leader_elector` extension enabled in `service.extensions` (both ship in
 * otelcol-contrib and otelcol-k8s at the pinned v0.130.0), so only the
 * leader collects.
 *
 * One build root at a time (chant #1939).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { docsToManifests } from "./k8s-helpers";
import { allPipelines, collectorPlacements, componentType, describePlacement, type CollectorConfigShape } from "./otel-placement-helpers";

/** Why a `k8s_cluster` receiver is not behind a working leader elector, or undefined when it is. */
function missingLeader(config: CollectorConfigShape, id: string): string | undefined {
  const cfg = config.receivers?.[id];
  const ref = typeof cfg === "object" && cfg !== null ? (cfg as Record<string, unknown>).k8s_leader_elector : undefined;
  if (typeof ref !== "string" || ref.length === 0) return `${id} has no k8s_leader_elector`;
  if (componentType(ref) !== "k8s_leader_elector" || !(config.extensions && ref in config.extensions)) {
    return `${id} names k8s_leader_elector "${ref}", which is not a declared k8s_leader_elector extension`;
  }
  const enabled = Array.isArray(config.service.extensions) && config.service.extensions.includes(ref);
  if (!enabled) return `${id} names k8s_leader_elector "${ref}", which is not enabled in service.extensions`;
  return undefined;
}

export const wk8603: PostSynthCheck = {
  id: "WK8603",
  description:
    "OpenTelemetry Collector runs the k8s_cluster receiver in a DaemonSet or multi-replica workload without a k8s_leader_elector; every copy reports every cluster object. Sees one build root at a time (chant #1939).",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const p of collectorPlacements(docsToManifests(ctx))) {
      const copies = p.kind === "DaemonSet" ? "every node" : p.replicas !== undefined && p.replicas > 1 ? `each of up to ${p.replicas} replicas` : undefined;
      if (!copies) continue;

      const used = new Set<string>();
      for (const [, pipeline] of allPipelines(p.config)) {
        for (const id of pipeline.receivers) if (componentType(id) === "k8s_cluster") used.add(id);
      }
      const reasons = [...used].map((id) => missingLeader(p.config, id)).filter((r): r is string => r !== undefined);
      if (reasons.length === 0) continue;

      diagnostics.push({
        checkId: "WK8603",
        severity: "warning",
        message:
          `${describePlacement(p)} runs the k8s_cluster receiver on ${copies} (${p.where}): ${reasons.join("; ")}. ` +
          `Each copy reports every cluster object, duplicating series and API server watches. ` +
          `Run it in a single-replica Deployment, or reference a k8s_leader_elector extension from the receiver and enable it in service.extensions.`,
        entity: p.name,
        lexicon: "k8s",
      });
    }
    return diagnostics;
  },
};
