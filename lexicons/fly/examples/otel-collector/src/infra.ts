/**
 * An OpenTelemetry Collector on a Fly Machine.
 *
 * The collector runs in its own app. Machines in the same organization send
 * OTLP to `otel-collector.internal:4317` over the private network, and the
 * collector forwards everything to an OTLP HTTP backend. The API key comes
 * from the machine's environment, set as a Fly secret, so it never appears in
 * the config: `${env:OTLP_API_KEY}` is the collector's own substitution.
 */
import { App, Fly } from "@intentius/chant-lexicon-fly";
import { FlyOtelCollector } from "@intentius/chant-lexicon-fly";
import { OtlpHttpExporter } from "@intentius/chant-lexicon-otel";

const app = new App({ name: "otel-collector", org_slug: Fly.OrgSlug });

const headers: Record<string, string> = { "x-api-key": "${env:OTLP_API_KEY}" };

const collector = FlyOtelCollector({
  exporters: [new OtlpHttpExporter({ endpoint: "https://otlp.example.com", headers })],
});

export { app, collector };
