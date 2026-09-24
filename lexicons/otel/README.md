# @intentius/chant-lexicon-otel

OpenTelemetry Collector lexicon for [chant](https://github.com/INTENTIUS/chant): typed receivers, processors, exporters, extensions and pipelines, serialized to the collector YAML `otelcol --config` reads.

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
| processors | batch, memory_limiter, resource, attributes, k8sattributes, resourcedetection |
| exporters | otlp, otlphttp, debug, prometheus, googlecloud |
| extensions | health_check, pprof, zpages |

The config types follow the collector-contrib release in `COLLECTOR_PIN`.

## Components chant doesn't ship

`defineComponent<Config>()({ kind, type, pin, validate?, endpoints? })` returns a class that serializes and lints like a built-in. `pin` records the schema source and version the config type follows; it is written as a `# chant:` comment above the emitted config and returned by `collectorTopology()`.

## Checks

OTEL001 and OTEL002 run on source (id syntax, literal credentials). OTEL101 to OTEL109 run after a build: undeclared or unused components, empty pipelines, extension wiring, `memory_limiter` placement, id syntax, each component's own config rules, duplicate ids and missing schema pins.

## Plain-data API

- `collectorYaml(entities)` and `buildCollectorConfig(entities)` render a config inside another lexicon (the k8s `GkeOtelCollector` uses them).
- `validateCollectorConfig(config)` and `validateCollectorEntities(entities)` run the checks without a build.
- `collectorTopology(config)` and `collectorTopologyOf(entities)` return pipelines, endpoints, schema pins and the signals each exporter carries.

## Project structure

- `src/define.ts`: `defineComponent`, the registry and schema pins
- `src/components/`: the built-in component classes and config types
- `src/pipeline.ts`: `Pipeline` and `Service`
- `src/collector.ts`, `src/yaml.ts`: entities to config to YAML
- `src/validate-config.ts`, `src/lint/`: checks
- `src/topology.ts`: the read surface
- `examples/`: getting-started, k8s-node-agent, custom-component
