/**
 * DockerOtelCollector composite: an OpenTelemetry Collector as a Compose
 * service.
 *
 * The collector config is declared with the otel lexicon
 * (`@intentius/chant-lexicon-otel`), rendered with `collectorYaml`, and
 * carried inline in a top-level Compose config that the service mounts. The
 * published ports are read back from the config, so they follow whatever
 * config is passed in.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import type { Declarable } from "@intentius/chant/declarable";
import {
  buildCollectorConfig,
  collectorEndpoints,
  collectorYaml,
  otlpCollector,
  COLLECTOR_CONFIG_PATH,
  COLLECTOR_IMAGE,
  type OTelComponent,
  type Signal,
} from "@intentius/chant-lexicon-otel";
import { Service, DockerConfig } from "../generated/index";

export interface DockerOtelCollectorProps {
  /** Collector image (default: the contrib image at the otel lexicon's pinned collector version). */
  image?: string;
  /**
   * The collector config, as otel lexicon entities (components and
   * pipelines). Replaces the default config, and `exporters` and `signals`
   * are then ignored.
   */
  config?: Iterable<Declarable>;
  /** Exporters for the default config (default: one `debug` exporter). */
  exporters?: OTelComponent<"exporter", string, any>[];
  /** Signals the default config has pipelines for (default: traces, metrics and logs). */
  signals?: Signal[];
  /** Publish the receiver ports on the host (default: true). Other services on the network reach the collector either way. */
  publishPorts?: boolean;
  /** Restart policy (default: "unless-stopped"). */
  restart?: string;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    service?: Partial<Record<string, unknown>>;
    config?: Partial<Record<string, unknown>>;
  };
}

/**
 * Create a DockerOtelCollector composite. Returns a Compose service and the
 * config it mounts. The service key is the export name plus `Service`.
 *
 * @example
 * ```ts
 * import { DockerOtelCollector } from "@intentius/chant-lexicon-docker";
 * import { OtlpExporter } from "@intentius/chant-lexicon-otel";
 *
 * export const otel = DockerOtelCollector({
 *   exporters: [new OtlpExporter({ endpoint: "tempo:4317", tls: { insecure: true } })],
 * });
 * ```
 */
export const DockerOtelCollector = Composite((props: DockerOtelCollectorProps) => {
  const { image = COLLECTOR_IMAGE, publishPorts = true, restart = "unless-stopped", defaults: defs } = props;

  const entities = props.config ? [...props.config] : otlpCollector({ exporters: props.exporters, signals: props.signals });
  const { ports } = collectorEndpoints(buildCollectorConfig(entities).config);

  const config = new DockerConfig(mergeDefaults({
    content: collectorYaml(entities),
  }, defs?.config));

  const service = new Service(mergeDefaults({
    image,
    command: [`--config=${COLLECTOR_CONFIG_PATH}`],
    configs: [{ source: config, target: COLLECTOR_CONFIG_PATH }],
    ...(publishPorts && ports.length > 0 ? { ports: ports.map((p) => `${p.port}:${p.port}`) } : {}),
    restart,
  }, defs?.service));

  return { service, config };
}, "DockerOtelCollector");
