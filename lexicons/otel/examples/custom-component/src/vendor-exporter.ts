/**
 * A component chant doesn't ship, defined once by the team that uses it.
 *
 * In real use this file lives in a package (say `@acme/otel-components`), and
 * the package version is what pins the definition for every project that
 * imports it. `pin` records which schema the config type follows; it is
 * written above the emitted config and returned by `collectorTopology()`.
 */
import { defineComponent } from "@intentius/chant-lexicon-otel";

export interface SplunkHecExporterConfig {
  token: string;
  endpoint: string;
  source?: string;
  sourcetype?: string;
  index?: string;
  tls?: { insecure_skip_verify?: boolean; ca_file?: string };
}

export const SplunkHecExporter = defineComponent<SplunkHecExporterConfig>()({
  kind: "exporter",
  type: "splunk_hec",
  pin: {
    source: "github.com/open-telemetry/opentelemetry-collector-contrib/exporter/splunkhecexporter",
    version: "v0.130.0",
  },
  description: "Sends logs, metrics and traces to a Splunk HTTP Event Collector",
  validate: (c) => {
    const problems: string[] = [];
    if (!c.token.includes("${")) problems.push("token must be an ${env:...} or ${file:...} reference");
    if (!c.endpoint.startsWith("https://")) problems.push("endpoint should be https://");
    return problems;
  },
  endpoints: (c) => [c.endpoint],
});
