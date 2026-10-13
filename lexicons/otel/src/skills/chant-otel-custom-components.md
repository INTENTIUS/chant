---
skill: chant-otel-custom-components
description: Add a collector component chant doesn't ship (a vendor exporter, an in-house processor) with defineComponent, and pin its schema
user-invocable: true
---

# Custom collector components

chant ships a core set of collector components. For anything else, define the component once and use it like a built-in.

```ts
import { defineComponent, Pipeline, OtlpReceiver } from "@intentius/chant-lexicon-otel";

export interface DatadogExporterConfig {
  api: { key: string; site?: string };
  traces?: { span_name_as_resource_name?: boolean };
}

export const DatadogExporter = defineComponent<DatadogExporterConfig>()({
  kind: "exporter",
  type: "datadog",
  pin: {
    source: "github.com/open-telemetry/opentelemetry-collector-contrib/exporter/datadogexporter",
    version: "v0.130.0",
  },
  validate: (c) => (c.api.key.includes("${") ? [] : ["api.key must come from ${env:...}"]),
  endpoints: (c) => [`https://api.${c.api.site ?? "datadoghq.com"}`],
});

export const dd = new DatadogExporter({ name: "eu", api: { key: "${env:DD_API_KEY}", site: "datadoghq.eu" } });
export const traces = new Pipeline({ signal: "traces", receivers: [new OtlpReceiver({ protocols: { grpc: {} } })], exporters: [dd] });
```

## What you supply

| Field | Required | Meaning |
|---|---|---|
| `kind` | yes | receiver, processor, exporter or extension |
| `type` | yes | the collector type, the part of the id before `/` |
| `pin` | yes | `{ source, version, digest? }`: where the config schema comes from and which release the type follows |
| `validate` | no | a function returning problems, or any zod-compatible schema (anything with `safeParse`) |
| `endpoints` | no | where the component sends or listens, for `collectorTopology()` |
| `description` | no | one line for docs |

## How it is checked and pinned

- The same serializer emits it, and OTEL101-OTEL108 apply to it as to any built-in. `validate` failures are OTEL107.
- The pin is written as a `# chant: exporter datadog/eu schema <source>@<version>` comment above the emitted config, and returned by `collectorTopology()`.
- A definition without a usable pin fails the build (OTEL109).
- chant records the pin; it does not fetch or verify the schema. Ship the definition in a package and the package version pins it for everyone who imports it.
- You cannot redefine a built-in type. Declare a named instance instead (`new OtlpExporter({ name: "vendor", ... })`).
