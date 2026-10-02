/**
 * Built-in sampling components: the tail_sampling and probabilistic_sampler
 * processors, and the loadbalancing exporter that routes every span of a trace
 * to the same collector so tail sampling sees whole traces.
 *
 * Field shapes follow `processor/tailsamplingprocessor`,
 * `processor/probabilisticsamplerprocessor` and
 * `exporter/loadbalancingexporter` at `COLLECTOR_PIN`.
 */

import { defineBuiltin } from "../define";
import type { Duration, ExporterHelperSettings, GRPCClientSettings } from "./common";

// ── tail_sampling ────────────────────────────────────────────────────

/** Samples a trace whose duration is at least `threshold_ms` (and below `upper_threshold_ms`, when set). */
export interface LatencyPolicyConfig {
  threshold_ms: number;
  upper_threshold_ms?: number;
}

/** Samples a trace with a span whose integer attribute `key` falls within `min_value` to `max_value`. */
export interface NumericAttributePolicyConfig {
  key: string;
  min_value?: number;
  max_value?: number;
  invert_match?: boolean;
}

/** Samples a fixed percentage of traces by trace id hash. */
export interface ProbabilisticPolicyConfig {
  sampling_percentage: number;
  hash_salt?: string;
}

export type SpanStatusCode = "OK" | "ERROR" | "UNSET";

/** Samples a trace with a span whose status is one of `status_codes`. */
export interface StatusCodePolicyConfig {
  status_codes: SpanStatusCode[];
}

/** Samples a trace with a span whose string attribute `key` matches one of `values`. */
export interface StringAttributePolicyConfig {
  key: string;
  values: string[];
  enabled_regex_matching?: boolean;
  cache_max_size?: number;
  invert_match?: boolean;
}

/** Samples traces until `spans_per_second` is reached. */
export interface RateLimitingPolicyConfig {
  spans_per_second: number;
}

/** Samples a trace whose span count falls within `min_spans` to `max_spans`. */
export interface SpanCountPolicyConfig {
  min_spans: number;
  max_spans?: number;
}

/** Samples a trace whose W3C trace state key `key` has one of `values`. */
export interface TraceStatePolicyConfig {
  key: string;
  values: string[];
}

/** Samples a trace with a span whose boolean attribute `key` equals `value`. */
export interface BooleanAttributePolicyConfig {
  key: string;
  value: boolean;
  invert_match?: boolean;
}

/** Samples a trace when any OTTL condition on a span or span event is true. */
export interface OttlConditionPolicyConfig {
  error_mode?: "ignore" | "silent" | "propagate";
  span?: string[];
  spanevent?: string[];
}

interface PolicyBase<T extends string> {
  /** Unique within its list; the collector refuses an empty or repeated name. */
  name: string;
  type: T;
}

export interface AlwaysSamplePolicy extends PolicyBase<"always_sample"> {}
export interface LatencyPolicy extends PolicyBase<"latency"> {
  latency: LatencyPolicyConfig;
}
export interface NumericAttributePolicy extends PolicyBase<"numeric_attribute"> {
  numeric_attribute: NumericAttributePolicyConfig;
}
export interface ProbabilisticPolicy extends PolicyBase<"probabilistic"> {
  probabilistic: ProbabilisticPolicyConfig;
}
export interface StatusCodePolicy extends PolicyBase<"status_code"> {
  status_code: StatusCodePolicyConfig;
}
export interface StringAttributePolicy extends PolicyBase<"string_attribute"> {
  string_attribute: StringAttributePolicyConfig;
}
export interface RateLimitingPolicy extends PolicyBase<"rate_limiting"> {
  rate_limiting: RateLimitingPolicyConfig;
}
export interface SpanCountPolicy extends PolicyBase<"span_count"> {
  span_count: SpanCountPolicyConfig;
}
export interface TraceStatePolicy extends PolicyBase<"trace_state"> {
  trace_state: TraceStatePolicyConfig;
}
export interface BooleanAttributePolicy extends PolicyBase<"boolean_attribute"> {
  boolean_attribute: BooleanAttributePolicyConfig;
}
export interface OttlConditionPolicy extends PolicyBase<"ottl_condition"> {
  ottl_condition: OttlConditionPolicyConfig;
}

/** A policy that decides on its own: every type except `and`, `composite` and `drop`. Also the shape of an `and` sub-policy. */
export type TailSamplingLeafPolicy =
  | AlwaysSamplePolicy
  | LatencyPolicy
  | NumericAttributePolicy
  | ProbabilisticPolicy
  | StatusCodePolicy
  | StringAttributePolicy
  | RateLimitingPolicy
  | SpanCountPolicy
  | TraceStatePolicy
  | BooleanAttributePolicy
  | OttlConditionPolicy;

/** Samples a trace only when every sub-policy samples it. */
export interface AndPolicy extends PolicyBase<"and"> {
  and: { and_sub_policy: TailSamplingLeafPolicy[] };
}

/** Drops a trace when every sub-policy matches it, whatever the other policies decide. */
export interface DropPolicy extends PolicyBase<"drop"> {
  drop: { drop_sub_policy: TailSamplingLeafPolicy[] };
}

/** A composite sub-policy: a leaf policy or an `and`. */
export type CompositeSubPolicy = TailSamplingLeafPolicy | AndPolicy;

/**
 * Shares `max_total_spans_per_second` between sub-policies. Each
 * `rate_allocation` entry names a sub-policy and its percent of the budget;
 * `policy_order` is the order sub-policies are evaluated in.
 */
export interface CompositePolicy extends PolicyBase<"composite"> {
  composite: {
    max_total_spans_per_second: number;
    policy_order: string[];
    composite_sub_policy: CompositeSubPolicy[];
    rate_allocation?: Array<{ policy: string; percent: number }>;
  };
}

/** One entry in `tail_sampling.policies`, discriminated by `type`. The config sits under the key named by `type`. */
export type TailSamplingPolicy = TailSamplingLeafPolicy | AndPolicy | DropPolicy | CompositePolicy;

export type TailSamplingPolicyType = TailSamplingPolicy["type"];

export interface TailSamplingProcessorConfig {
  /** How long after a trace's first span the decision is made. The collector's default is 30s; chant asks for it explicitly. */
  decision_wait: Duration;
  /** Policies, evaluated for every trace. A trace is sampled when any policy samples it and no `drop` policy drops it. */
  policies: TailSamplingPolicy[];
  num_traces?: number;
  expected_new_traces_per_sec?: number;
  decision_cache?: {
    sampled_cache_size?: number;
    non_sampled_cache_size?: number;
  };
  sample_on_first_match?: boolean;
}

/**
 * Holds each trace for `decision_wait`, then samples it when a policy says so.
 * Tail sampling needs every span of a trace in one collector: run it on a
 * gateway behind the `loadbalancing` exporter, not on a per-node agent.
 */
export const TailSamplingProcessor = defineBuiltin<TailSamplingProcessorConfig, "processor", "tail_sampling">({
  kind: "processor",
  type: "tail_sampling",
  description: "Samples whole traces by policy after waiting for their spans: errors, latency, attributes, rate",
  validate: (c) => {
    const problems: string[] = [];
    if (!c.decision_wait) problems.push("decision_wait is not set; declare how long to wait for a trace's spans");
    if (!Array.isArray(c.policies) || c.policies.length === 0) {
      problems.push("policies is empty, so no trace is ever sampled");
    } else {
      policyListProblems(c.policies, "policies", problems);
    }
    return problems;
  },
});

const STATUS_CODES: ReadonlySet<string> = new Set(["OK", "ERROR", "UNSET"]);

function policyListProblems(policies: ReadonlyArray<TailSamplingPolicy>, path: string, problems: string[]): void {
  const seen = new Set<string>();
  policies.forEach((p, i) => {
    const at = `${path}[${i}]`;
    if (!p || typeof p !== "object") {
      problems.push(`${at} is not a policy`);
      return;
    }
    if (!p.name) problems.push(`${at} has no name`);
    else if (seen.has(p.name)) problems.push(`${at}: policy name "${p.name}" is repeated`);
    else seen.add(p.name);
    const label = p.name ? `${at} (${p.name})` : at;
    policyProblems(p, label, problems);
  });
}

function policyProblems(p: TailSamplingPolicy, at: string, problems: string[]): void {
  const cfg = (p as unknown as Record<string, unknown>)[p.type];
  if (p.type !== "always_sample" && (typeof cfg !== "object" || cfg === null)) {
    problems.push(`${at}: type ${p.type} needs a ${p.type} block`);
    return;
  }
  switch (p.type) {
    case "latency":
      if (!(p.latency.threshold_ms > 0) && !(p.latency.upper_threshold_ms && p.latency.upper_threshold_ms > 0)) {
        problems.push(`${at}: latency needs threshold_ms or upper_threshold_ms above 0`);
      }
      if (p.latency.upper_threshold_ms !== undefined && p.latency.upper_threshold_ms <= p.latency.threshold_ms) {
        problems.push(`${at}: latency upper_threshold_ms must be above threshold_ms`);
      }
      break;
    case "numeric_attribute":
      if (!p.numeric_attribute.key) problems.push(`${at}: numeric_attribute needs a key`);
      if (
        p.numeric_attribute.min_value !== undefined &&
        p.numeric_attribute.max_value !== undefined &&
        p.numeric_attribute.max_value < p.numeric_attribute.min_value
      ) {
        problems.push(`${at}: numeric_attribute max_value is below min_value`);
      }
      break;
    case "probabilistic": {
      const pct = p.probabilistic.sampling_percentage;
      if (typeof pct !== "number" || pct <= 0 || pct > 100) {
        problems.push(`${at}: probabilistic sampling_percentage must be above 0 and at most 100`);
      }
      break;
    }
    case "status_code": {
      const codes = p.status_code.status_codes ?? [];
      if (codes.length === 0) problems.push(`${at}: status_code needs at least one status code`);
      for (const code of codes) {
        if (!STATUS_CODES.has(code)) problems.push(`${at}: status code "${code}" is not OK, ERROR or UNSET`);
      }
      break;
    }
    case "string_attribute":
      if (!p.string_attribute.key) problems.push(`${at}: string_attribute needs a key`);
      if (!p.string_attribute.values?.length) problems.push(`${at}: string_attribute needs at least one value`);
      break;
    case "rate_limiting":
      if (!(p.rate_limiting.spans_per_second > 0)) problems.push(`${at}: rate_limiting spans_per_second must be above 0`);
      break;
    case "span_count":
      if (p.span_count.max_spans !== undefined && p.span_count.max_spans < p.span_count.min_spans) {
        problems.push(`${at}: span_count max_spans is below min_spans`);
      }
      break;
    case "trace_state":
      if (!p.trace_state.key) problems.push(`${at}: trace_state needs a key`);
      if (!p.trace_state.values?.length) problems.push(`${at}: trace_state needs at least one value`);
      break;
    case "boolean_attribute":
      if (!p.boolean_attribute.key) problems.push(`${at}: boolean_attribute needs a key`);
      break;
    case "ottl_condition":
      if (!p.ottl_condition.span?.length && !p.ottl_condition.spanevent?.length) {
        problems.push(`${at}: ottl_condition needs a span or spanevent condition`);
      }
      break;
    case "and":
      subPolicyProblems(p.and.and_sub_policy, `${at}.and.and_sub_policy`, problems);
      break;
    case "drop":
      subPolicyProblems(p.drop.drop_sub_policy, `${at}.drop.drop_sub_policy`, problems);
      break;
    case "composite": {
      const comp = p.composite;
      if (!(comp.max_total_spans_per_second > 0)) problems.push(`${at}: composite max_total_spans_per_second must be above 0`);
      const subs = comp.composite_sub_policy ?? [];
      if (subs.length === 0) {
        problems.push(`${at}: composite has no composite_sub_policy`);
        break;
      }
      policyListProblems(subs, `${at}.composite.composite_sub_policy`, problems);
      const names = new Set(subs.map((s) => s.name));
      for (const n of comp.policy_order ?? []) {
        if (!names.has(n)) problems.push(`${at}: policy_order names "${n}", which is not a composite_sub_policy`);
      }
      let total = 0;
      for (const r of comp.rate_allocation ?? []) {
        if (!names.has(r.policy))
          problems.push(`${at}: rate_allocation names "${r.policy}", which is not a composite_sub_policy`);
        total += r.percent;
      }
      if (total > 100) problems.push(`${at}: rate_allocation percents add up to ${total}, above 100`);
      break;
    }
    default:
      break;
  }
}

function subPolicyProblems(subs: ReadonlyArray<TailSamplingPolicy> | undefined, path: string, problems: string[]): void {
  if (!subs || subs.length === 0) {
    problems.push(`${path} is empty`);
    return;
  }
  policyListProblems(subs, path, problems);
}

// ── probabilistic_sampler ────────────────────────────────────────────

export interface ProbabilisticSamplerProcessorConfig {
  /** Percent of traces or logs kept, 0 to 100. The collector's default is 0, which keeps nothing, so chant asks for it. */
  sampling_percentage: number;
  /** Salt for `hash_seed` mode. Collectors that sample the same data must share it. */
  hash_seed?: number;
  /** `hash_seed` (the default for logs), `proportional` (the default for traces) or `equalizing`. */
  mode?: "hash_seed" | "proportional" | "equalizing";
  /** Default true: an item without usable randomness is dropped. */
  fail_closed?: boolean;
  /** Hex digits of threshold precision, 1 to 14; default 4. */
  sampling_precision?: number;
  /** Logs only: sample on the trace id (default) or on `from_attribute` of the record. */
  attribute_source?: "traceID" | "record";
  from_attribute?: string;
  /** Logs only: an attribute whose value overrides the sampling percentage for its record. */
  sampling_priority?: string;
}

/** Head sampling: keeps a fixed percentage of traces or logs, decided per item without waiting for the rest of the trace. */
export const ProbabilisticSamplerProcessor = defineBuiltin<
  ProbabilisticSamplerProcessorConfig,
  "processor",
  "probabilistic_sampler"
>({
  kind: "processor",
  type: "probabilistic_sampler",
  description: "Head sampling: keeps a fixed percentage of traces or logs",
  validate: (c) => {
    const problems: string[] = [];
    const pct = c.sampling_percentage;
    if (typeof pct !== "number" || Number.isNaN(pct)) {
      problems.push("sampling_percentage is not set; the collector's default of 0 keeps nothing");
    } else if (pct < 0 || pct > 100) {
      problems.push(`sampling_percentage (${pct}) must be between 0 and 100`);
    }
    if (c.sampling_precision !== undefined && (c.sampling_precision < 1 || c.sampling_precision > 14)) {
      problems.push(`sampling_precision (${c.sampling_precision}) must be between 1 and 14`);
    }
    if (c.attribute_source === "record" && !c.from_attribute) {
      problems.push("attribute_source is record but from_attribute is not set");
    }
    if (c.hash_seed !== undefined && c.mode !== undefined && c.mode !== "hash_seed") {
      problems.push(`hash_seed is only read in hash_seed mode, not ${c.mode}`);
    }
    return problems;
  },
});

// ── loadbalancing ────────────────────────────────────────────────────

/** A fixed list of backends, each `host` or `host:port` (port 4317 when omitted). */
export interface StaticResolverConfig {
  hostnames: string[];
}

/** Backends found by resolving a DNS name, e.g. a headless Service. */
export interface DnsResolverConfig {
  hostname: string;
  /** Default `4317`. */
  port?: string;
  interval?: Duration;
  timeout?: Duration;
}

/** Backends found by watching a Kubernetes Service's endpoints. Needs RBAC to list and watch EndpointSlices. */
export interface K8sResolverConfig {
  /** `name` or `name.namespace`. */
  service: string;
  /** Default `[4317]`. */
  ports?: number[];
  timeout?: Duration;
  /** Use pod hostnames instead of IPs, e.g. for a StatefulSet behind a headless Service. */
  return_hostnames?: boolean;
}

/** Backends found in AWS Cloud Map. */
export interface AwsCloudMapResolverConfig {
  namespace: string;
  service_name: string;
  health_status?: "HEALTHY" | "UNHEALTHY" | "ALL" | "HEALTHY_OR_ELSE_ALL";
  interval?: Duration;
  timeout?: Duration;
  port?: number;
}

/** Exactly one resolver; the collector refuses none or several. */
export type LoadBalancingResolver =
  | {
      static: StaticResolverConfig;
      dns?: never;
      k8s?: never;
      aws_cloud_map?: never;
    }
  | {
      dns: DnsResolverConfig;
      static?: never;
      k8s?: never;
      aws_cloud_map?: never;
    }
  | {
      k8s: K8sResolverConfig;
      static?: never;
      dns?: never;
      aws_cloud_map?: never;
    }
  | {
      aws_cloud_map: AwsCloudMapResolverConfig;
      static?: never;
      dns?: never;
      k8s?: never;
    };

/**
 * `traceID` (the default for traces and logs), `service` or `attributes` for
 * traces; `service` (the default for metrics), `resource`, `metric` or
 * `streamID` for metrics. Logs always route by trace id.
 */
export type LoadBalancingRoutingKey = "traceID" | "service" | "attributes" | "resource" | "metric" | "streamID";

/** The otlp exporter settings used for every backend. The endpoint comes from the resolver, so it is not set here. */
export type LoadBalancingOtlpConfig = Omit<GRPCClientSettings, "endpoint"> & ExporterHelperSettings;

export type LoadBalancingExporterConfig = ExporterHelperSettings & {
  protocol?: { otlp: LoadBalancingOtlpConfig };
  resolver: LoadBalancingResolver;
  routing_key?: LoadBalancingRoutingKey;
  /** With `routing_key: attributes`, the span attributes to route on. */
  routing_attributes?: string[];
};

const RESOLVER_KEYS = ["static", "dns", "k8s", "aws_cloud_map"] as const;

/**
 * Sends each trace (or service, or metric stream) to one backend chosen by a
 * consistent hash over the resolver's backends. Put it on the agents in front
 * of a multi-replica gateway that runs `tail_sampling`.
 */
export const LoadBalancingExporter = defineBuiltin<LoadBalancingExporterConfig, "exporter", "loadbalancing">({
  kind: "exporter",
  type: "loadbalancing",
  description: "Routes all spans of a trace to one backend collector by trace id, for tail sampling behind it",
  validate: (c) => {
    const problems: string[] = [];
    const r = (c.resolver ?? {}) as Record<string, unknown>;
    const set = RESOLVER_KEYS.filter((k) => r[k] !== undefined && r[k] !== null);
    if (set.length === 0) problems.push("resolver has none of static, dns, k8s or aws_cloud_map");
    if (set.length > 1) problems.push(`resolver sets ${set.join(" and ")}; the collector takes exactly one`);
    const res = c.resolver as unknown as
      | Partial<{
          static: StaticResolverConfig;
          dns: DnsResolverConfig;
          k8s: K8sResolverConfig;
          aws_cloud_map: AwsCloudMapResolverConfig;
        }>
      | undefined;
    if (res?.static && !res.static.hostnames?.length) problems.push("resolver.static.hostnames is empty");
    if (res?.dns && !res.dns.hostname) problems.push("resolver.dns.hostname is empty");
    if (res?.k8s) {
      if (!res.k8s.service) problems.push("resolver.k8s.service is empty");
      if (res.k8s.ports && res.k8s.ports.length === 0) problems.push("resolver.k8s.ports is empty; omit it for the default 4317");
    }
    if (res?.aws_cloud_map && (!res.aws_cloud_map.namespace || !res.aws_cloud_map.service_name)) {
      problems.push("resolver.aws_cloud_map needs namespace and service_name");
    }
    if (c.routing_key === "attributes" && !c.routing_attributes?.length) {
      problems.push("routing_key is attributes but routing_attributes is empty");
    }
    if (c.routing_attributes?.length && c.routing_key !== "attributes") {
      problems.push("routing_attributes is only read with routing_key: attributes");
    }
    const otlp = c.protocol?.otlp as Record<string, unknown> | undefined;
    if (otlp && "endpoint" in otlp) problems.push("protocol.otlp.endpoint is ignored; backends come from the resolver");
    return problems;
  },
  endpoints: (c) => loadBalancingEndpoints(c.resolver),
});

/**
 * The backends a `loadbalancing` resolver names, as `host:port` where it can:
 * static hostnames as given, a DNS name with its port, a Kubernetes Service
 * once per port, a Cloud Map service as `aws-cloud-map://namespace/service`.
 */
export function loadBalancingEndpoints(resolver: LoadBalancingResolver | undefined): string[] {
  if (!resolver) return [];
  if (resolver.static) return [...(resolver.static.hostnames ?? [])];
  if (resolver.dns) return resolver.dns.hostname ? [`${resolver.dns.hostname}:${resolver.dns.port ?? "4317"}`] : [];
  if (resolver.k8s) {
    if (!resolver.k8s.service) return [];
    return (resolver.k8s.ports?.length ? resolver.k8s.ports : [4317]).map((p) => `${resolver.k8s!.service}:${p}`);
  }
  if (resolver.aws_cloud_map) {
    return [`aws-cloud-map://${resolver.aws_cloud_map.namespace}/${resolver.aws_cloud_map.service_name}`];
  }
  return [];
}
