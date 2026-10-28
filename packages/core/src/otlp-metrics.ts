/**
 * OTLP gauges (#4612): the metrics half of chant's exporter (./otlp.ts,
 * #4555, traces only), for the estate's delivery metrics. Same transport:
 * OTLP/JSON over HTTP with `fetch`, no SDK, off with no endpoint. It reads
 * the metrics variables the way ./otlp.ts reads the traces ones, and the
 * way terragucci's src/telemetry.ts reads both:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT           base URL; /v1/metrics is added
 *   OTEL_EXPORTER_OTLP_METRICS_ENDPOINT   the metrics URL, used as given
 *   OTEL_EXPORTER_OTLP_HEADERS, OTEL_EXPORTER_OTLP_METRICS_HEADERS
 *   OTEL_METRICS_EXPORTER                 `none` turns metrics off
 *   OTEL_SDK_DISABLED=true                turns them off
 *   OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES
 *
 * The body is terragucci's `metricsBody`: one gauge data point each,
 * grouped by name, so a collector that took terragucci's gauges takes these.
 */
import { CHANT_VERSION } from "./chant-version";
import { activeProductWords } from "./ci-product-words";
import { parseOtlpPairs, sendOtlp, type OtlpAttrs, type OtlpFetch, type OtlpTarget } from "./otlp";

/** One gauge: a value now, with its attributes. */
export interface OtlpGauge {
  name: string;
  unit: string;
  description: string;
  value: number;
  attributes: Record<string, string>;
}

/** Where gauges go, from the environment, or why they do not. */
export interface OtlpMetricsConfig {
  metrics?: OtlpTarget;
  resource: OtlpAttrs;
  skipped: string[];
}

/** The metrics settings from `env`, or undefined when no endpoint is set or the SDK is disabled. `service.name` defaults to the product's name. */
export function otlpMetricsFromEnv(env: NodeJS.ProcessEnv = process.env, opts: { product?: string } = {}): OtlpMetricsConfig | undefined {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return undefined;
  const exporter = env.OTEL_METRICS_EXPORTER;
  if (exporter !== undefined && exporter.trim() !== "" && !exporter.split(",").map((s) => s.trim()).includes("otlp")) return undefined;
  const own = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim();
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const url = own || (base ? `${base.replace(/\/+$/, "")}/v1/metrics` : undefined);
  if (!url) return undefined;
  const resource: OtlpAttrs = { ...parseOtlpPairs(env.OTEL_RESOURCE_ATTRIBUTES) };
  resource["service.name"] = env.OTEL_SERVICE_NAME?.trim() || resource["service.name"] || (opts.product ?? activeProductWords().product);
  const skipped: string[] = [];
  const protocol = env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL;
  if (protocol === "grpc") skipped.push("metrics: chant sends OTLP over HTTP and the protocol is grpc; point it at the collector's HTTP port");
  else if (!/^https?:\/\//.test(url)) skipped.push(`metrics: ${url} is not an http or https URL`);
  if (skipped.length) return { resource, skipped };
  return { metrics: { url, headers: { ...parseOtlpPairs(env.OTEL_EXPORTER_OTLP_HEADERS), ...parseOtlpPairs(env.OTEL_EXPORTER_OTLP_METRICS_HEADERS) } }, resource, skipped };
}

const attrList = (attrs: OtlpAttrs): { key: string; value: Record<string, unknown> }[] =>
  Object.entries(attrs)
    .filter((e): e is [string, string | number | boolean] => e[1] !== undefined)
    .map(([key, v]) => ({ key, value: typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } }));

/** The OTLP/JSON body for gauges, one data point each, grouped by name. `at` is the time in nanoseconds. */
export function otlpMetricsBody(gauges: readonly OtlpGauge[], resource: OtlpAttrs, at: bigint = BigInt(Date.now()) * 1_000_000n, version: string = CHANT_VERSION): unknown {
  const byName = new Map<string, OtlpGauge[]>();
  for (const g of gauges) byName.set(g.name, [...(byName.get(g.name) ?? []), g]);
  return {
    resourceMetrics: [{
      resource: { attributes: attrList(resource) },
      scopeMetrics: [{
        scope: { name: "chant", version },
        metrics: [...byName.values()].map((gs) => ({
          name: gs[0]!.name,
          unit: gs[0]!.unit,
          description: gs[0]!.description,
          gauge: { dataPoints: gs.map((g) => ({ attributes: attrList(g.attributes), timeUnixNano: String(at), asDouble: g.value })) },
        })),
      }],
    }],
  };
}

/** What sending gauges came to: how many went, or why none did. */
export type OtlpGaugesSent = { sent: number } | { problem: string };

/**
 * Send gauges when the environment names a metrics endpoint. Undefined when
 * it names none. Never throws: a collector that fails is the problem.
 */
export async function sendOtlpGauges(gauges: readonly OtlpGauge[], opts: { env?: NodeJS.ProcessEnv; fetch?: OtlpFetch; product?: string; version?: string } = {}): Promise<OtlpGaugesSent | undefined> {
  const config = otlpMetricsFromEnv(opts.env ?? process.env, opts.product !== undefined ? { product: opts.product } : {});
  if (!config) return undefined;
  if (!config.metrics) return { problem: config.skipped.join("; ") };
  if (gauges.length === 0) return { sent: 0 };
  const problem = await sendOtlp(config.metrics, otlpMetricsBody(gauges, { ...config.resource, ...(opts.version ? { "service.version": opts.version } : {}) }), opts.fetch);
  return problem ? { problem } : { sent: gauges.length };
}
