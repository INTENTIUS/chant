/**
 * WK8602: `tail_sampling` on a multi-replica gateway that collectors reach
 * without trace-aware load balancing
 *
 * Tail sampling needs every span of a trace in the same process. Behind a
 * ClusterIP Service, connections are spread across the gateway replicas with
 * no regard for trace ids, so the spans of one trace land on different
 * replicas and each samples a fragment. The fix is a `loadbalancing`
 * exporter in front, routing by `traceID` to the replicas themselves (the
 * `k8s` resolver on any Service that selects them, or the `dns` resolver on
 * a headless one). A single-replica gateway passes.
 *
 * The check fires on evidence, not on absence: another collector in the
 * build whose traces pipeline exports to one of the gateway's Services
 * through `otlp`/`otlphttp`, through a `loadbalancing` exporter routed by
 * something other than `traceID`, or through the `dns` resolver on a
 * ClusterIP Service (one virtual IP, so one backend per connection). When
 * the senders live in another build root, or are applications talking to
 * the gateway directly, it stays silent (chant #1939).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { canonicalTypeOf } from "@intentius/chant-lexicon-otel/model";
import { docsToManifests } from "./k8s-helpers";
import {
  collectorPlacements,
  describePlacement,
  hostOfEndpoint,
  pipelinesOf,
  serviceOfHost,
  servicesSelecting,
  tracePipelineProcessors,
  type CollectorPlacement,
} from "./otel-placement-helpers";

const TRACE_ID_KEYS = new Set([undefined, null, "", "traceID"]);

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Why each traces exporter of `sender` that reaches `services` does so without trace-aware routing. */
function unroutedExporters(sender: CollectorPlacement, services: Map<string, boolean>): string[] {
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const [, pipeline] of pipelinesOf(sender.config, "traces")) {
    for (const id of pipeline.exporters) {
      if (seen.has(id)) continue;
      seen.add(id);
      const type = canonicalTypeOf("exporter", id);
      const cfg = record(sender.config.exporters?.[id]);

      if (type === "loadbalancing") {
        const resolver = record(cfg.resolver);
        const k8sService = record(resolver.k8s).service;
        const dnsHost = record(resolver.dns).hostname;
        let target: string | undefined;
        if (typeof k8sService === "string") {
          const svc = serviceOfHost(k8sService, sender.namespace);
          if (svc && services.has(svc)) target = svc;
        } else if (typeof dnsHost === "string") {
          const svc = serviceOfHost(dnsHost, sender.namespace);
          if (svc && services.has(svc)) {
            target = svc;
            if (!services.get(svc)) {
              reasons.push(`${id} resolves ClusterIP Service ${svc} through dns, which returns one virtual IP rather than the replicas`);
              continue;
            }
          }
        }
        if (target && !TRACE_ID_KEYS.has(cfg.routing_key as string | undefined)) {
          reasons.push(`${id} routes by ${String(cfg.routing_key)}, not traceID`);
        }
        continue;
      }

      if (type === "otlp" || type === "otlphttp") {
        for (const field of ["endpoint", "traces_endpoint"]) {
          const host = hostOfEndpoint(cfg[field]);
          const svc = host ? serviceOfHost(host, sender.namespace) : undefined;
          if (svc && services.has(svc)) {
            reasons.push(`${id} sends to Service ${svc} directly`);
            break;
          }
        }
      }
    }
  }
  return reasons;
}

export const wk8602: PostSynthCheck = {
  id: "WK8602",
  description:
    "OpenTelemetry Collector gateway runs tail_sampling on more than one replica, but collectors send it traces without a loadbalancing exporter routed by traceID. Sees one build root at a time (chant #1939).",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const manifests = docsToManifests(ctx);
    const placements = collectorPlacements(manifests);
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const gateway of placements) {
      if (gateway.kind === "DaemonSet" || gateway.replicas === undefined || gateway.replicas <= 1) continue;
      const tail = tracePipelineProcessors(gateway.config, "tail_sampling");
      if (tail.length === 0) continue;

      const services = new Map<string, boolean>();
      for (const s of servicesSelecting(manifests, gateway.workload)) services.set(`${s.name}.${s.namespace}`, s.headless);
      if (services.size === 0) continue;

      const senders = new Set<string>();
      for (const sender of placements) {
        if (sender.workload === gateway.workload) continue;
        const key = `${sender.kind}/${sender.namespace}/${sender.name}/${sender.configMap}/${sender.key}`;
        if (senders.has(key)) continue;
        senders.add(key);
        const reasons = unroutedExporters(sender, services);
        if (reasons.length === 0) continue;
        diagnostics.push({
          checkId: "WK8602",
          severity: "warning",
          message:
            `${describePlacement(gateway)} runs ${tail.join(", ")} on up to ${gateway.replicas} replicas, and ${describePlacement(sender)} sends it traces without trace-aware routing: ${reasons.join("; ")}. ` +
            `Spans of one trace land on different replicas and each samples a fragment. ` +
            `Export traces through a loadbalancing exporter with routing_key traceID (gatewayExporter(gateway, { loadBalance: true })), or run one replica.`,
          entity: gateway.name,
          lexicon: "k8s",
        });
      }
    }
    return diagnostics;
  },
};
