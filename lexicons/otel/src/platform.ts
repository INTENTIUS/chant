/**
 * What the platform composites share: a default collector config, the image
 * that runs it, where the config is mounted, and the ports a rendered config
 * listens on.
 *
 * The docker, k8s and fly collector composites build on this. A composite
 * declares its config with this lexicon, renders it with `collectorYaml`, and
 * reads the listening ports back from the built config, so the ports it
 * publishes follow whatever config the caller declared.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { COLLECTOR_PIN, type OTelComponent } from "./define";
import { OtlpReceiver } from "./components/receivers";
import { BatchProcessor, MemoryLimiterProcessor } from "./components/processors";
import { DebugExporter } from "./components/exporters";
import { HealthCheckExtension } from "./components/extensions";
import { Pipeline } from "./pipeline";
import { SIGNALS, parseComponentId, type CollectorConfig, type Signal } from "./model";

/** The contrib collector image at the version the built-in components are typed against. */
export const COLLECTOR_IMAGE = `otel/opentelemetry-collector-contrib:${COLLECTOR_PIN.version.replace(/^v/, "")}`;

/** Where the platform composites mount the rendered config inside the container. */
export const COLLECTOR_CONFIG_PATH = "/etc/otel/config.yaml";

export interface OtlpCollectorOptions {
  /** Where telemetry goes. Default: one `debug` exporter at `basic` verbosity. */
  exporters?: OTelComponent<"exporter", string, any>[];
  /** Which signals get a pipeline. Default: traces, metrics and logs. */
  signals?: Signal[];
  /** Serve `health_check` on 0.0.0.0:13133. Default: true. */
  healthCheck?: boolean;
}

/**
 * The entities of a small OTLP collector: an `otlp` receiver on 4317 (gRPC)
 * and 4318 (HTTP), `memory_limiter` then `batch`, the given exporters, and a
 * `health_check` extension. Pass the result to `collectorYaml`.
 */
export function otlpCollector(options: OtlpCollectorOptions = {}): Declarable[] {
  const { exporters = [new DebugExporter({ verbosity: "basic" })], signals = [...SIGNALS], healthCheck = true } = options;
  const otlp = new OtlpReceiver({
    protocols: {
      grpc: { endpoint: "0.0.0.0:4317" },
      http: { endpoint: "0.0.0.0:4318" },
    },
  });
  const memoryLimiter = new MemoryLimiterProcessor({
    check_interval: "1s",
    limit_percentage: 80,
    spike_limit_percentage: 20,
  });
  const batch = new BatchProcessor({});
  const entities: Declarable[] = [otlp, memoryLimiter, batch, ...exporters];
  if (healthCheck) entities.push(new HealthCheckExtension({ endpoint: "0.0.0.0:13133" }));
  for (const signal of signals) {
    entities.push(new Pipeline({ signal, receivers: [otlp], processors: [memoryLimiter, batch], exporters }));
  }
  return entities;
}

/** A port a collector config listens on. */
export interface CollectorPort {
  /** A name usable as a k8s port name: lowercase, `-` separated, at most 15 characters. */
  name: string;
  port: number;
}

export interface CollectorEndpoints {
  /** Ports the receivers listen on, in config order, one entry per port. */
  ports: CollectorPort[];
  /**
   * The `health_check` extension, when the service enables one and it listens
   * on an address other than localhost. A probe from outside the container
   * cannot reach a localhost listener.
   */
  healthCheck?: { port: number; path: string };
}

function portOf(endpoint: unknown): { host: string; port: number } | undefined {
  if (typeof endpoint !== "string") return undefined;
  const m = endpoint.match(/^(.*):(\d+)$/);
  if (!m) return undefined;
  return { host: m[1], port: Number(m[2]) };
}

function portName(parts: string[]): string {
  const name = parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return name.slice(0, 15).replace(/-$/, "");
}

/** Every `endpoint` value under a receiver's config, with the key path that led to it. */
function receiverEndpoints(value: unknown, path: string[], out: Array<{ path: string[]; endpoint: unknown }>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "endpoint") out.push({ path, endpoint: child });
    else receiverEndpoints(child, [...path, key], out);
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * The ports a built collector config listens on: every receiver `endpoint`,
 * named after the receiver and the protocol key above it (`otlp-grpc`,
 * `otlp-http`), and the `health_check` port if the service enables it.
 */
export function collectorEndpoints(config: CollectorConfig): CollectorEndpoints {
  const ports: CollectorPort[] = [];
  const seen = new Set<number>();
  for (const [id, receiverConfig] of Object.entries(config.receivers ?? {})) {
    const found: Array<{ path: string[]; endpoint: unknown }> = [];
    receiverEndpoints(receiverConfig, [], found);
    const parsed = parseComponentId(id);
    const base = parsed ? [parsed.type, ...(parsed.name ? [parsed.name] : [])] : [id];
    for (const { path, endpoint } of found) {
      const p = portOf(endpoint);
      if (!p || seen.has(p.port)) continue;
      seen.add(p.port);
      const protocol = path.filter((k) => k !== "protocols");
      ports.push({ name: portName([...base, ...protocol]), port: p.port });
    }
  }

  let healthCheck: CollectorEndpoints["healthCheck"];
  const enabled = config.service?.extensions ?? [];
  for (const id of enabled) {
    if (parseComponentId(id)?.type !== "health_check") continue;
    const ext = (config.extensions?.[id] ?? {}) as { endpoint?: unknown; path?: unknown };
    const p = portOf(ext.endpoint ?? "localhost:13133");
    if (!p || LOCAL_HOSTS.has(p.host)) continue;
    healthCheck = { port: p.port, path: typeof ext.path === "string" ? ext.path : "/" };
    break;
  }

  return { ports, ...(healthCheck ? { healthCheck } : {}) };
}
