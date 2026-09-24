---
skill: chant-otel
description: Declare OpenTelemetry Collector config (receivers, processors, exporters, pipelines) as typed chant entities and build collector YAML
user-invocable: true
---

# OpenTelemetry Collector config with chant

The otel lexicon (`@intentius/chant-lexicon-otel`) types collector config. Each receiver, processor, exporter and extension is an entity, pipelines reference them, and `chant build` writes one collector config file.

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
| receivers | otlp, prometheus, hostmetrics, filelog |
| processors | batch, memory_limiter, resource, attributes, k8sattributes, resourcedetection |
| exporters | otlp, otlphttp, debug, prometheus, googlecloud |
| extensions | health_check, pprof, zpages |

Anything else goes through `defineComponent`; see the `chant-otel-custom-components` skill.

## Rules

- Reference components by entity where you can. A string id (`"otlp/backend"`) is allowed for a component declared elsewhere, and OTEL101 fails the build if nothing declares it.
- Put `memory_limiter` first in `processors` (OTEL105).
- Never write a credential literally. Use `"${env:NAME}"` and the collector reads it at start-up (OTEL002).
- Every pipeline needs at least one receiver and one exporter (OTEL102). A declared component no pipeline uses is a warning (OTEL103).
- Declared extensions are enabled in declaration order unless a `Service` lists `extensions` itself.

## Reading the result

`collectorTopologyOf(entities)` returns the pipelines, each component's endpoints and schema pin, and for each exporter the signals it carries, as plain data.
