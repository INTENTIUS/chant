/**
 * The collector's components, declared with the otel lexicon.
 *
 * OTLP comes in on both protocols. Traces and metrics go to Tempo, and logs
 * are printed by the debug exporter. The health_check extension gives the
 * DaemonSet its probes.
 */
import {
  OtlpReceiver,
  MemoryLimiterProcessor,
  BatchProcessor,
  OtlpExporter,
  DebugExporter,
  HealthCheckExtension,
  type OtlpReceiverConfig,
  type TLSClientSettings,
} from "@intentius/chant-lexicon-otel";

const protocols: OtlpReceiverConfig["protocols"] = {
  grpc: { endpoint: "0.0.0.0:4317" },
  http: { endpoint: "0.0.0.0:4318" },
};

const plaintext: TLSClientSettings = { insecure: true };

const otlp = new OtlpReceiver({ protocols });

const memoryLimiter = new MemoryLimiterProcessor({ check_interval: "1s", limit_percentage: 80, spike_limit_percentage: 20 });
const batch = new BatchProcessor({ timeout: "5s" });

const tempo = new OtlpExporter({ name: "tempo", endpoint: "tempo.observability.svc:4317", tls: plaintext });
const debug = new DebugExporter({ verbosity: "basic" });

const health = new HealthCheckExtension({ endpoint: "0.0.0.0:13133" });

export { otlp, memoryLimiter, batch, tempo, debug, health };
