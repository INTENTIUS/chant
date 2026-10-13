/**
 * The custom exporter used next to built-ins: same constructor shape, same
 * pipeline references, same checks.
 */
import { OtlpReceiver, BatchProcessor, Pipeline, type OtlpReceiverConfig } from "@intentius/chant-lexicon-otel";
import { SplunkHecExporter } from "./vendor-exporter";

const protocols: OtlpReceiverConfig["protocols"] = { http: { endpoint: "0.0.0.0:4318" } };
const otlp = new OtlpReceiver({ protocols });

const batch = new BatchProcessor({ timeout: "5s" });

const splunk = new SplunkHecExporter({
  name: "security",
  token: "${env:SPLUNK_HEC_TOKEN}",
  endpoint: "https://hec.splunk.example:8088/services/collector",
  index: "otel",
  sourcetype: "otel",
});

const logs = new Pipeline({
  signal: "logs",
  receivers: [otlp],
  processors: [batch],
  exporters: [splunk],
});

export { otlp, batch, splunk, logs };
