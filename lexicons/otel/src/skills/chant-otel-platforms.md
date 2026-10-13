---
skill: chant-otel-platforms
description: Run a declared collector config on Kubernetes, GKE, Docker or Fly by rendering it into the platform's own config file
user-invocable: true
---

# Running the collector config on a platform

The otel lexicon produces collector YAML. A platform lexicon runs the collector and carries the YAML to it.

## Rendering the YAML inside another lexicon

`collectorYaml(entities)` returns exactly what the otel serializer would emit for those entities. Use it wherever a platform needs the config as a string:

```ts
import { OtlpReceiver, DebugExporter, Pipeline, collectorYaml } from "@intentius/chant-lexicon-otel";
import { ConfigMap } from "@intentius/chant-lexicon-k8s";

const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
const debug = new DebugExporter({ verbosity: "basic" });

export const collectorConfig = new ConfigMap({
  metadata: { name: "otel-collector-config" },
  data: { "config.yaml": collectorYaml([otlp, debug, new Pipeline({ signal: "traces", receivers: [otlp], exporters: [debug] })]) },
});
```

## GKE

The k8s lexicon's `GkeOtelCollector` composite is built this way: it declares an otlp receiver, batch and resourcedetection processors and a googlecloud exporter, renders them with `collectorYaml`, and mounts the result from a ConfigMap into a DaemonSet running under Workload Identity.

## Checking a rendered config

`validateCollectorConfig(config)` runs OTEL101-OTEL106 over any parsed collector config, so a composite's generated YAML can be checked in its own tests.
