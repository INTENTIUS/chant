/**
 * WK8601: `tail_sampling` in a collector that runs once per node
 *
 * A DaemonSet collector sees the spans produced on its own node. A trace
 * whose services run on several nodes arrives in pieces, one piece per
 * agent, and `tail_sampling` decides on each piece alone: an error span on
 * node A doesn't keep the rest of the trace on node B, and latency policies
 * measure a fragment. Nothing fails; the sampled traces are just incomplete.
 * Tail sampling belongs on a gateway that receives whole traces (see WK8602
 * for the multi-replica gateway case).
 *
 * Reads the collector config from the ConfigMap the DaemonSet runs, joined
 * through `otel-placement-helpers.ts`. One build root at a time (chant #1939).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { docsToManifests } from "./k8s-helpers";
import { collectorPlacements, describePlacement, tracePipelineProcessors } from "./otel-placement-helpers";

export const wk8601: PostSynthCheck = {
  id: "WK8601",
  description:
    "OpenTelemetry Collector runs tail_sampling as a per-node DaemonSet; each agent sees only its node's spans, so decisions are made on partial traces. Sees one build root at a time (chant #1939).",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const p of collectorPlacements(docsToManifests(ctx))) {
      if (p.kind !== "DaemonSet") continue;
      const ids = tracePipelineProcessors(p.config, "tail_sampling");
      if (ids.length === 0) continue;
      diagnostics.push({
        checkId: "WK8601",
        severity: "warning",
        message:
          `${describePlacement(p)} runs ${ids.join(", ")} (${p.where}) on every node. ` +
          `Each agent sees only its own node's spans, so sampling decisions are made on partial traces. ` +
          `Move tail sampling to a gateway (OtelCollectorGateway) and send traces to it through a loadbalancing exporter routed by traceID.`,
        entity: p.name,
        lexicon: "k8s",
      });
    }
    return diagnostics;
  },
};
