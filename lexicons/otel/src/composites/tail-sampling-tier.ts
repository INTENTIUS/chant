/**
 * `TailSamplingTier`: the collector config of a tail sampling tier on any
 * host (VMs, Docker, Fly, ECS), for where the k8s lexicon's
 * `OtelCollectorGateway` does not run.
 *
 * Tail sampling needs every span of a trace in one collector. The agents in
 * front send to this tier through a `loadbalancing` exporter that routes by
 * trace id (`tailSamplingLoadBalancer()` declares it), and each replica of
 * the tier holds a trace for `decisionWait`, then keeps it when a policy
 * says so:
 *
 * - `errors`: any span ended in error (default: on);
 * - `slowerThanMs`: the trace took at least this long (default 1000 ms);
 * - `percentage`: a baseline share of everything else (default 10%);
 * - `policies`: more `tail_sampling` policies of your own, after those.
 *
 * The pipeline is `otlp` in, `memory_limiter`, `tail_sampling`, `batch`, the
 * given exporters out. Compute span metrics before this tier (the agents, or
 * `RedMetrics`), or they count only the traces kept.
 */

import { Composite, type CompositeInstance } from "@intentius/chant/composite";
import { goDurationMs, type Duration } from "../components/common";
import { OtlpReceiver } from "../components/receivers";
import { BatchProcessor, MemoryLimiterProcessor } from "../components/processors";
import { DebugExporter } from "../components/exporters";
import { HealthCheckExtension } from "../components/extensions";
import {
  LoadBalancingExporter,
  TailSamplingProcessor,
  type LoadBalancingExporterConfig,
  type LoadBalancingResolver,
  type TailSamplingPolicy,
  type TailSamplingProcessorConfig,
} from "../components/sampling";
import type { OTelComponent } from "../define";
import { Pipeline, type PipelineEntity } from "../pipeline";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Exporter = OTelComponent<"exporter", string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TraceSource = OTelComponent<"receiver" | "connector", string, any>;
type Component<K extends "receiver" | "processor" | "exporter" | "extension"> = OTelComponent<K, string, object>;

export interface TailSamplingTierProps {
  /** Where the kept traces go. Default: one `debug` exporter at `basic` verbosity. */
  exporters?: Exporter[];
  /** Where spans come from. Default: an `otlp` receiver on 4317 (gRPC) and 4318 (HTTP). */
  receivers?: TraceSource[];
  /** How long after a trace's first span the decision is made (default `10s`). */
  decisionWait?: Duration;
  /** Keep every trace with a span ended in error (default: on). */
  errors?: boolean;
  /** Keep every trace that took at least this many milliseconds (default 1000; `false` for none). */
  slowerThanMs?: number | false;
  /** Keep this percentage of all other traces, by trace id hash (default 10; `false` for none). */
  percentage?: number | false;
  /** More policies, evaluated after the ones above. */
  policies?: TailSamplingPolicy[];
  /** How many traces to hold in memory at once (default: the collector's 50000). */
  numTraces?: number;
  /** `memory_limiter`'s hard limit in MiB (default: 80% of the container's memory, with a 20% spike limit). */
  memoryLimitMib?: number;
  /** Serve `health_check` on 0.0.0.0:13133 (default: on). */
  healthCheck?: boolean;
}

// A type alias, not an interface: a composite's members type needs the implicit index signature.
export type TailSamplingTierMembers = {
  otlp?: Component<"receiver">;
  memoryLimiter: Component<"processor">;
  tailSampling: OTelComponent<"processor", "tail_sampling", TailSamplingProcessorConfig>;
  batch: Component<"processor">;
  /** The default `debug` exporter, when no `exporters` are given. */
  debug?: Component<"exporter">;
  health?: Component<"extension">;
  traces: PipelineEntity;
};

export type TailSamplingTierInstance = CompositeInstance<TailSamplingTierMembers> & TailSamplingTierMembers;

/** Why a set of `TailSamplingTier` props can't build, or undefined when they can. */
export function tailSamplingTierPropsProblem(props: TailSamplingTierProps = {}): string | undefined {
  if (props.exporters !== undefined && props.exporters.length === 0) return "exporters must name at least one exporter when set";
  if (props.receivers !== undefined && props.receivers.length === 0) return "receivers must name at least one receiver when set";
  if (props.decisionWait !== undefined) {
    const ms = goDurationMs(props.decisionWait, 0);
    if (ms === undefined || ms <= 0) return `decisionWait ${JSON.stringify(props.decisionWait)} is not a positive duration`;
  }
  const s = props.slowerThanMs;
  if (s !== undefined && s !== false && !(Number.isInteger(s) && s > 0)) return "slowerThanMs must be a positive whole number of milliseconds, or false";
  const pc = props.percentage;
  if (pc !== undefined && pc !== false && !(typeof pc === "number" && pc > 0 && pc <= 100)) return "percentage must be above 0 and at most 100, or false";
  if (props.numTraces !== undefined && !(Number.isInteger(props.numTraces) && props.numTraces > 0)) return "numTraces must be a positive whole number";
  if (props.memoryLimitMib !== undefined && !(Number.isInteger(props.memoryLimitMib) && props.memoryLimitMib > 0)) {
    return "memoryLimitMib must be a positive whole number";
  }
  if (tierPolicies(props).length === 0) return "every policy is off, so no trace would ever be kept";
  return undefined;
}

function tierPolicies(props: TailSamplingTierProps): TailSamplingPolicy[] {
  const out: TailSamplingPolicy[] = [];
  if (props.errors !== false) out.push({ name: "errors", type: "status_code", status_code: { status_codes: ["ERROR"] } });
  const slow = props.slowerThanMs ?? 1000;
  if (slow !== false) out.push({ name: "slow", type: "latency", latency: { threshold_ms: slow } });
  const pc = props.percentage ?? 10;
  if (pc !== false) out.push({ name: "baseline", type: "probabilistic", probabilistic: { sampling_percentage: pc } });
  return [...out, ...(props.policies ?? [])];
}

/**
 * The collector config of a tail sampling tier: whole traces in, the ones
 * a policy keeps out.
 *
 * @example
 * ```ts
 * import { TailSamplingTier, OtlpExporter } from "@intentius/chant-lexicon-otel";
 *
 * const tempo = new OtlpExporter({ name: "tempo", endpoint: "tempo:4317", tls: { insecure: true } });
 * export const sampler = TailSamplingTier({ exporters: [tempo], slowerThanMs: 500, percentage: 5 });
 * ```
 */
export const TailSamplingTier = Composite<TailSamplingTierProps, TailSamplingTierMembers>((input) => {
  const props = input ?? {};
  const problem = tailSamplingTierPropsProblem(props);
  if (problem) throw new Error(`TailSamplingTier: ${problem}`);

  const otlp = props.receivers
    ? undefined
    : new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" }, http: { endpoint: "0.0.0.0:4318" } } });
  const memoryLimiter = new MemoryLimiterProcessor(
    props.memoryLimitMib !== undefined
      ? { check_interval: "1s", limit_mib: props.memoryLimitMib, spike_limit_mib: Math.ceil(props.memoryLimitMib / 4) }
      : { check_interval: "1s", limit_percentage: 80, spike_limit_percentage: 20 },
  );
  const tailSampling = new TailSamplingProcessor({
    decision_wait: props.decisionWait ?? "10s",
    ...(props.numTraces !== undefined ? { num_traces: props.numTraces } : {}),
    policies: tierPolicies(props),
  });
  const batch = new BatchProcessor({});
  const debug = props.exporters ? undefined : new DebugExporter({ verbosity: "basic" });
  const traces = new Pipeline({
    signal: "traces",
    receivers: props.receivers ?? [otlp!],
    processors: [memoryLimiter, tailSampling, batch],
    exporters: props.exporters ?? [debug!],
  });
  const health = props.healthCheck === false ? undefined : new HealthCheckExtension({ endpoint: "0.0.0.0:13133" });

  // A composite member must be a declarable, so the parts that are off are left out rather than undefined.
  const members: TailSamplingTierMembers = { memoryLimiter, tailSampling, batch, traces };
  if (otlp) members.otlp = otlp;
  if (debug) members.debug = debug;
  if (health) members.health = health;
  return members;
}, "TailSamplingTier");

/**
 * The exporter the agents in front of a `TailSamplingTier` send traces with:
 * a `loadbalancing` exporter that routes every span of a trace to the same
 * replica of the tier, by trace id.
 *
 * @example
 * ```ts
 * // TLS by default; pass `{ otlp: { tls: { insecure: true } } }` as `protocol` on a private network.
 * const toSampler = tailSamplingLoadBalancer({ dns: { hostname: "sampler.internal" } }, "sampler");
 * ```
 */
export function tailSamplingLoadBalancer(
  resolver: LoadBalancingResolver,
  name?: string,
  protocol?: LoadBalancingExporterConfig["protocol"],
): OTelComponent<"exporter", "loadbalancing", LoadBalancingExporterConfig> {
  return new LoadBalancingExporter({
    ...(name !== undefined ? { name } : {}),
    routing_key: "traceID",
    ...(protocol !== undefined ? { protocol } : {}),
    resolver,
  });
}
