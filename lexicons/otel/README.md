# @intentius/chant-lexicon-otel

OpenTelemetry Collector lexicon for [chant](https://github.com/INTENTIUS/chant): typed receivers, processors, exporters, connectors, extensions and pipelines, serialized to the collector YAML `otelcol --config` reads.

```ts
import { OtlpReceiver, BatchProcessor, OtlpExporter, Pipeline } from "@intentius/chant-lexicon-otel";

const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
const batch = new BatchProcessor({ timeout: "5s" });
const backend = new OtlpExporter({ name: "backend", endpoint: "tempo:4317" });
const traces = new Pipeline({ signal: "traces", receivers: [otlp], processors: [batch], exporters: [backend] });

export { otlp, batch, backend, traces };
```

## Built-in components

| Kind | Types |
|---|---|
| receivers | otlp, prometheus, hostmetrics, filelog, k8s_cluster, kubeletstats |
| processors | batch, memory_limiter, resource, attributes, k8sattributes, resourcedetection, filter, transform, redaction, tail_sampling, probabilistic_sampler |
| exporters | otlp, otlphttp, debug, prometheus, googlecloud, loadbalancing |
| connectors | spanmetrics, servicegraph, routing, forward, count, sum |
| extensions | health_check, pprof, zpages |

The config types follow the collector-contrib release in `COLLECTOR_PIN`.

Sampling and routing: `tail_sampling` takes its policies as a discriminated union (`status_code`, `latency`, `probabilistic`, `and`, `composite` and the rest), and `loadbalancing` takes a `static`, `dns`, `k8s` or `aws_cloud_map` resolver. Content handling: `filter`, `transform` (OTTL statement groups per context) and `redaction`. Cluster metrics: `k8s_cluster` and `kubeletstats`.

To run a config on Kubernetes, pass the same entities to the k8s lexicon's `OtelCollector` (a DaemonSet agent) or `OtelCollectorGateway` (a Deployment), and wire agents to a gateway with `gatewayExporter()`. [`examples/agent-observability`](../../examples/agent-observability) puts an agent, a sampled gateway with span and GenAI metrics, an SLO and Grafana dashboards together on k3d.

## Connectors

A connector joins two pipelines: it is an exporter in the pipeline that feeds it and a receiver in the pipeline it feeds. Put the same entity on both sides.

```ts
const spanmetrics = new SpanMetricsConnector({ dimensions: [{ name: "http.route" }] });

export const traces = new Pipeline({ signal: "traces", receivers: [otlp], exporters: [backend, spanmetrics] });
export const red = new Pipeline({ signal: "metrics", name: "red", receivers: [spanmetrics], exporters: [prom] });
```

Each connector supports fixed signal pairs (`spanmetrics`: traces to metrics). OTEL101 fails a connector listed on one side only, OTEL112 fails a pipeline whose signal the connector can't pair, and `collectorTopology()` reports each pipeline-to-pipeline hop in `edges`. A custom connector declares its pairs with `connects` in `defineComponent`.

`spanMetricsNames(connector)` returns the Prometheus names of a `spanmetrics` connector's metrics (`traces_span_metrics_calls_total` and so on), read from its namespace, dimensions and histogram unit, for queries and dashboards that should follow the declaration.

## GenAI preset

`genAiPipeline(options)` returns a collector for workloads that emit OpenTelemetry GenAI spans. Prompt, completion, system-instruction and tool-call content is deleted from spans, span events and log records unless `keepContent: true` is set, and every GenAI span becomes call, error, duration and token metrics before any sampling. The attribute keys follow `GENAI_SEMCONV_PIN` (semantic-conventions v1.41.1), which `collectorTopology()` returns under `semconv`. `genAiComponents()` gives the pieces for pipelines of your own, and `genAiMetrics()` the metric names a dashboard reads.

## Components chant doesn't ship

`defineComponent<Config>()({ kind, type, pin, validate?, endpoints?, connects? })` returns a class that serializes and lints like a built-in. `pin` records the schema source and version the config type follows; it is written as a `# chant:` comment above the emitted config and returned by `collectorTopology()`.

## Checks

OTEL001 and OTEL002 run on source (id syntax, literal credentials). OTEL101 to OTEL109 and OTEL112 run after a build: undeclared or unused components (a connector must be on both sides), empty pipelines, extension wiring, `memory_limiter` placement, id syntax, each component's own config rules, duplicate ids, missing schema pins, and connector signal pairs.

## Plain-data API

- `collectorYaml(entities)` and `buildCollectorConfig(entities)` render a config inside another lexicon (the k8s `GkeOtelCollector` uses them).
- `validateCollectorConfig(config)` and `validateCollectorEntities(entities)` run the checks without a build.
- `collectorTopology(config)` and `collectorTopologyOf(entities)` return pipelines, endpoints, schema pins, the signals each exporter carries, the connector edges between pipelines, and the semantic-convention pins the config's attribute keys follow.

## Project structure

- `src/define.ts`: `defineComponent`, the registry and schema pins
- `src/components/`: the built-in component classes and config types
- `src/pipeline.ts`: `Pipeline` and `Service`
- `src/collector.ts`, `src/yaml.ts`: entities to config to YAML
- `src/validate-config.ts`, `src/lint/`: checks
- `src/topology.ts`, `src/semconv.ts`: the read surface
- `src/genai.ts`: the GenAI preset
- `examples/`: getting-started, k8s-node-agent, genai-agent, custom-component
