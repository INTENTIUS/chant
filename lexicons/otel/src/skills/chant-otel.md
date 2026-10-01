---
skill: chant-otel
description: Declare OpenTelemetry Collector config (receivers, processors, exporters, pipelines) as typed chant entities and build collector YAML
user-invocable: true
---

# OpenTelemetry Collector config with chant

The otel lexicon (`@intentius/chant-lexicon-otel`) types collector config. Each receiver, processor, exporter, connector and extension is an entity, pipelines reference them, and `chant build` writes one collector config file.

## Project setup

```ts
// chant.config.ts
export default { lexicons: ["otel"] };
```

## Declaring components

Every component class takes the collector's own config keys (snake_case, as in the collector docs) plus an optional `name`. The id is `type`, or `type/name` when `name` is set.

```ts
import {
  OtlpReceiver, MemoryLimiterProcessor, BatchProcessor, OtlpExporter, DebugExporter, Pipeline,
} from "@intentius/chant-lexicon-otel";

export const otlp = new OtlpReceiver({
  protocols: { grpc: { endpoint: "0.0.0.0:4317" }, http: { endpoint: "0.0.0.0:4318" } },
});
export const limiter = new MemoryLimiterProcessor({ check_interval: "1s", limit_percentage: 80, spike_limit_percentage: 20 });
export const batch = new BatchProcessor({ timeout: "5s" });
export const backend = new OtlpExporter({ name: "backend", endpoint: "tempo.observability:4317", tls: { insecure: true } });

export const traces = new Pipeline({ signal: "traces", receivers: [otlp], processors: [limiter, batch], exporters: [backend] });
```

Emits `receivers.otlp`, `processors.memory_limiter` and `processors.batch`, `exporters.otlp/backend`, and `service.pipelines.traces`.

## Built-in set

| Kind | Types |
|---|---|
| receivers | otlp, prometheus, hostmetrics, filelog, k8s_cluster, kubeletstats |
| processors | batch, memory_limiter, resource, attributes, k8sattributes, resourcedetection, filter, transform, redaction, tail_sampling, probabilistic_sampler |
| exporters | otlp, otlphttp, debug, prometheus, googlecloud, loadbalancing |
| connectors | spanmetrics, servicegraph, routing, forward, count, sum, signaltometrics |
| extensions | health_check, pprof, zpages |

Anything else goes through `defineComponent`; see the `chant-otel-custom-components` skill.

## Connectors

A connector joins two pipelines. List the same entity in `exporters` of the pipeline that feeds it and in `receivers` of the pipeline it feeds:

```ts
export const spanmetrics = new SpanMetricsConnector({ dimensions: [{ name: "http.route" }] });
export const traces = new Pipeline({ signal: "traces", receivers: [otlp], exporters: [backend, spanmetrics] });
export const red = new Pipeline({ signal: "metrics", name: "red", receivers: [spanmetrics], exporters: [prom] });
```

`spanmetrics` and `servicegraph` turn traces into metrics, `count` and `sum` turn any signal into metrics (`sum` adds up a numeric attribute), `signaltometrics` builds metrics you name, of any type, from any signal with OTTL values, `routing` and `forward` keep the signal. A connector on one side only fails OTEL101; a pipeline whose signal the connector can't pair fails OTEL112. Pipelines that feed each other in a loop through connectors fail OTEL113, a connector id that is also a receiver or exporter id fails OTEL114, and every pipeline a `routing` connector routes to must list it in `receivers` (OTEL115).

## GenAI workloads

For services that emit GenAI spans, start from the preset instead of writing the processors by hand:

```ts
export const collector = genAiPipeline({ traceExporters: [tempo], metricExporters: [prom] });
```

It deletes prompt, completion, system-instruction and tool-call content from spans, span events and logs, and derives call, error, duration and token metrics (`genai_calls_total`, `genai_duration_seconds`, `genai_tokens_input_total`, `genai_tokens_output_total`) from every GenAI span before sampling. Keep content only when asked, with `keepContent: true`. `genAiComponents()` returns the pieces for hand-built pipelines.

## Rules

- Reference components by entity where you can. A string id (`"otlp/backend"`) is allowed for a component declared elsewhere, and OTEL101 fails the build if nothing declares it.
- Put `memory_limiter` first in `processors` (OTEL105).
- Never write a credential literally. Use `"${env:NAME}"` and the collector reads it at start-up (OTEL002).
- Every pipeline needs at least one receiver and one exporter (OTEL102). A declared component no pipeline uses is a warning (OTEL103).
- Declared extensions are enabled in declaration order unless a `Service` lists `extensions` itself.

## Starting from an existing config

When the user already has a collector config file, import it rather than retyping it:

```bash
chant import otel-collector-config.yaml --output src
chant build src --lexicon otel -o collector.yaml   # the same config back
```

The importer writes `receivers.ts`, `processors.ts`, `exporters.ts`, `connectors.ts`, `extensions.ts`, `pipelines.ts`, and `service.ts` when extensions or telemetry need a `Service`. A component type with no built-in class lands in `custom-components.ts` as a `defineComponent` whose config is untyped data; offer to give it a config interface. Settings outside a built-in's config type still import and build, but `tsc` flags them. Read the warnings `chant import` prints: they name anything the lexicon has no place for.

## Reading the result

`collectorTopologyOf(entities)` returns the pipelines, each component's endpoints and schema pin, for each exporter the signals it carries, the connector `edges` between pipelines, and under `semconv` the semantic-conventions version (`GENAI_SEMCONV_PIN`) the config's `gen_ai.` keys follow, as plain data.
