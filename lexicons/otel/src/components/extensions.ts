/**
 * Built-in extensions: health_check, pprof, zpages, k8s_leader_elector.
 */

import { defineBuiltin } from "../define";
import type { Overlay, Require } from "./overlay";
import type { HealthCheckExtensionSchemaConfig, K8sLeaderElectorExtensionSchemaConfig, PprofExtensionSchemaConfig, ZPagesExtensionSchemaConfig } from "../generated/index";
import { goDurationMs, type TLSServerSettings } from "./common";

/**
 * The extension's config embeds contrib's `internal/healthcheck` Config, for
 * which upstream publishes no schema, so its fields are written here against
 * that package's config.go.
 */
export type HealthCheckExtensionConfig = Overlay<
  HealthCheckExtensionSchemaConfig,
  {
    /** Default `localhost:13133`. */
    endpoint?: string;
    path?: string;
    tls?: TLSServerSettings;
    response_body?: { healthy?: string; unhealthy?: string };
  }
>;

/** Serves an HTTP health endpoint for liveness and readiness probes. */
export const HealthCheckExtension = defineBuiltin<HealthCheckExtensionConfig, "extension", "health_check">({
  kind: "extension",
  type: "health_check",
  description: "Serves an HTTP health endpoint for liveness and readiness probes",
  endpoints: (c) => [`${c.endpoint ?? "localhost:13133"}${c.path ?? "/"}`],
});

export type PprofExtensionConfig = PprofExtensionSchemaConfig;

/** Serves Go's net/http/pprof profiling endpoints. */
export const PprofExtension = defineBuiltin<PprofExtensionConfig, "extension", "pprof">({
  kind: "extension",
  type: "pprof",
  description: "Serves Go pprof profiling endpoints",
  endpoints: (c) => [c.endpoint ?? "localhost:1777"],
});

export type ZPagesExtensionConfig = ZPagesExtensionSchemaConfig;

/** Serves in-process zPages for live debugging of pipelines. */
export const ZPagesExtension = defineBuiltin<ZPagesExtensionConfig, "extension", "zpages">({
  kind: "extension",
  type: "zpages",
  description: "Serves zPages for live debugging of receivers and exporters",
  endpoints: (c) => [c.endpoint ?? "localhost:55679"],
});

// ── k8s_leader_elector ───────────────────────────────────────────────
//
// Typed against extension/k8sleaderelector at COLLECTOR_PIN
// (collector-contrib v0.130.0): config.go, factory.go, leader_elector.go and README.md at that tag,
// https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/v0.130.0/extension/k8sleaderelector
// The config squashes internal/k8sconfig's APIConfig (`auth_type`, `context`).
// Upstream marks it alpha. It ships in the otelcol-contrib and otelcol-k8s
// distributions at v0.130.0.

/** The extension refuses to start without the Lease's name and namespace. */
export type K8sLeaderElectorExtensionConfig = Require<K8sLeaderElectorExtensionSchemaConfig, "lease_name" | "lease_namespace">;

/**
 * Elects one leader among collector replicas through a Kubernetes Lease, so a
 * receiver that names it (`k8s_cluster`'s `k8s_leader_elector`) collects only
 * in the replica holding the lease. The collector's ServiceAccount needs
 * access to `leases` in `coordination.k8s.io` in `lease_namespace`.
 */
export const K8sLeaderElectorExtension = defineBuiltin<K8sLeaderElectorExtensionConfig, "extension", "k8s_leader_elector">({
  kind: "extension",
  type: "k8s_leader_elector",
  description: "Elects one leader among collector replicas through a Kubernetes Lease",
  validate: (c) => {
    const problems: string[] = [];
    // config.go Validate.
    if (!c.lease_name || !c.lease_namespace) problems.push("lease_name and lease_namespace must be set");
    // client-go's leaderelection.NewLeaderElector, which leader_elector.go calls when the extension starts.
    const lease = goDurationMs(c.lease_duration, 15_000);
    const renew = goDurationMs(c.renew_deadline, 10_000);
    const retry = goDurationMs(c.retry_period, 2_000);
    for (const [key, ms] of [["lease_duration", lease], ["renew_deadline", renew], ["retry_period", retry]] as const) {
      if (ms !== undefined && ms <= 0) problems.push(`${key} must be positive`);
    }
    if (lease !== undefined && renew !== undefined && lease > 0 && renew > 0 && lease <= renew) {
      problems.push("lease_duration must be greater than renew_deadline");
    }
    if (renew !== undefined && retry !== undefined && renew > 0 && retry > 0 && renew <= 1.2 * retry) {
      problems.push("renew_deadline must be greater than 1.2 times retry_period");
    }
    return problems;
  },
});
