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
| receivers | otlp, prometheus, hostmetrics, filelog |
| processors | batch, memory_limiter, resource, attributes, k8sattributes, resourcedetection, tail_sampling, probabilistic_sampler |
| exporters | otlp, otlphttp, debug, prometheus, googlecloud, loadbalancing |
| connectors | spanmetrics, servicegraph, routing, forward, count |
| extensions | health_check, pprof, zpages |

The config types follow the collector-contrib release in `COLLECTOR_PIN`.

## Connectors

A connector joins two pipelines: it is an exporter in the pipeline that feeds it and a receiver in the pipeline it feeds. Put the same entity on both sides.

```ts
const spanmetrics = new SpanMetricsConnector({ dimensions: [{ name: "http.route" }] });

export const traces = new Pipeline({ signal: "traces", receivers: [otlp], exporters: [backend, spanmetrics] });
export const red = new Pipeline({ signal: "metrics", name: "red", receivers: [spanmetrics], exporters: [prom] });
```

Each connector supports fixed signal pairs (`spanmetrics`: traces to metrics). OTEL101 fails a connector listed on one side only, OTEL112 fails a pipeline whose signal the connector can't pair, and `collectorTopology()` reports each pipeline-to-pipeline hop in `edges`. A custom connector declares its pairs with `connects` in `defineComponent`.

## Components chant doesn't ship

`defineComponent<Config>()({ kind, type, pin, validate?, endpoints?, connects? })` returns a class that serializes and lints like a built-in. `pin` records the schema source and version the config type follows; it is written as a `# chant:` comment above the emitted config and returned by `collectorTopology()`.

## Checks

OTEL001 and OTEL002 run on source (id syntax, literal credentials). OTEL101 to OTEL109 and OTEL112 run after a build: undeclared or unused components (a connector must be on both sides), empty pipelines, extension wiring, `memory_limiter` placement, id syntax, each component's own config rules, duplicate ids, missing schema pins, and connector signal pairs.

## Plain-data API

- `collectorYaml(entities)` and `buildCollectorConfig(entities)` render a config inside another lexicon (the k8s `GkeOtelCollector` uses them).
- `validateCollectorConfig(config)` and `validateCollectorEntities(entities)` run the checks without a build.
- `collectorTopology(config)` and `collectorTopologyOf(entities)` return pipelines, endpoints, schema pins, the signals each exporter carries, and the connector edges between pipelines.

## Project structure

- `src/define.ts`: `defineComponent`, the registry and schema pins
- `src/components/`: the built-in component classes and config types
- `src/pipeline.ts`: `Pipeline` and `Service`
- `src/collector.ts`, `src/yaml.ts`: entities to config to YAML
- `src/validate-config.ts`, `src/lint/`: checks
- `src/topology.ts`: the read surface
- `examples/`: getting-started, k8s-node-agent, custom-component
