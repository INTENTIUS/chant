/**
 * An OpenTelemetry Collector next to Jaeger in Docker Compose.
 *
 * DockerOtelCollector runs the collector with the default config from the
 * otel lexicon: OTLP in on 4317 and 4318, memory_limiter and batch, and the
 * exporters given here. Services on the compose network send OTLP to
 * `otelService:4317`. Traces go on to Jaeger, whose UI is on port 16686.
 */
import { Service } from "@intentius/chant-lexicon-docker";
import { DockerOtelCollector } from "@intentius/chant-lexicon-docker";
import { OtlpExporter, type TLSClientSettings } from "@intentius/chant-lexicon-otel";

const jaeger = new Service({
  image: "jaegertracing/all-in-one:1.62.0",
  ports: ["16686:16686"],
  restart: "unless-stopped",
});

const plaintext: TLSClientSettings = { insecure: true };

const otel = DockerOtelCollector({
  exporters: [new OtlpExporter({ name: "jaeger", endpoint: "jaeger:4317", tls: plaintext })],
  signals: ["traces"],
});

export { jaeger, otel };
