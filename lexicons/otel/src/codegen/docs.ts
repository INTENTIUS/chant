/**
 * Documentation generation for the otel lexicon: the generated reference
 * pages from the core docs pipeline, plus the authored pages in docs/pages/.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

function serviceFromType(resourceType: string): string {
  const parts = resourceType.split("::");
  return parts.length >= 2 ? parts[1] : "OTel";
}

const overview = `The otel lexicon types [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)
config: receivers, processors, exporters, extensions and the pipelines that
connect them. \`chant build\` emits one collector config file, the YAML
\`otelcol --config\` reads as it is.

\`\`\`ts
import { OtlpReceiver, BatchProcessor, OtlpExporter, Pipeline } from "@intentius/chant-lexicon-otel";

export const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
export const batch = new BatchProcessor({ timeout: "5s" });
export const backend = new OtlpExporter({ name: "backend", endpoint: "tempo.observability:4317" });

export const traces = new Pipeline({
  signal: "traces",
  receivers: [otlp],
  processors: [batch],
  exporters: [backend],
});
\`\`\`

The built-in component set is otlp, prometheus, hostmetrics and filelog
receivers; batch, memory_limiter, resource, attributes, k8sattributes and
resourcedetection processors; otlp, otlphttp, debug, prometheus and
googlecloud exporters; and the health_check, pprof and zpages extensions.
Their config types follow the collector-contrib release named on the
Custom components page. A component chant doesn't ship is added with
\`defineComponent\`, and it is serialized and checked the same way as the
built-ins.

Checks catch a pipeline that uses a component nobody declared (OTEL101), a
pipeline with no receivers or exporters (OTEL102), a declared component no
pipeline uses (OTEL103), and a literal credential in source (OTEL002).
`;

const outputFormat = `The otel lexicon serializes every otel entity in a build into **one
collector config file** in YAML, the file \`otelcol --config\` reads.

- Sections come out as receivers, processors, exporters, extensions, service,
  separated by a blank line. Empty sections are left out.
- A component's id is its collector type, or \`type/name\` when its \`name\` is
  set. The export name in source never appears in the output.
- A list of scalars is written in flow style (\`receivers: [otlp]\`), any
  other list in block style. Strings are plain where YAML reads them back
  unchanged and double-quoted otherwise.
- Declared extensions are enabled in declaration order unless a \`Service\`
  lists \`extensions\`.
- Each custom component adds a \`# chant:\` comment line above the config
  naming its schema pin. Built-ins add none.
- A collector config has no metadata channel, so no ownership marker is
  stamped.
`;

export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  const config: DocsConfig = {
    name: "otel",
    displayName: "OpenTelemetry Collector",
    description: "Typed OpenTelemetry Collector config: receivers, processors, exporters and pipelines",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/otel/",
    overview,
    outputFormat,
    serviceFromType,
    srcDir: join(pkgDir, "src"),
    examplesDir: join(pkgDir, "examples"),
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (opts?.verbose) {
    console.error(`Generated ${result.pages.size} documentation pages`);
  }
}
