/**
 * FlyOtelCollector composite: an OpenTelemetry Collector on a Fly Machine.
 *
 * The collector config is declared with the otel lexicon
 * (`@intentius/chant-lexicon-otel`), rendered with `collectorYaml`, and
 * written into the machine as a file (`files[].raw_value`, base64). Other
 * machines in the organization reach it over the private network at
 * `<app>.internal` on the receiver ports. When the config serves a
 * `health_check` endpoint, the machine gets an HTTP check on it.
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
import { Fly } from "../pseudo";
import { Machine, MachineConfig, MachineGuest, MachineInit, MachineCheck, MachineRestart, File } from "../generated/index";

export interface FlyOtelCollectorProps {
  /** Machine name (default: "otel-collector"). */
  name?: string;
  /**
   * The app the machine belongs to, as an app name. Default: the stack's
   * only `App`, as for any machine.
   */
  app?: string | Declarable;
  /** Region (default: `Fly.Region`, which the build resolves from `FLY_REGION`). */
  region?: string | Declarable;
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
  /** Guest CPU kind (default: "shared"). */
  cpuKind?: string;
  /** Guest CPUs (default: 1). */
  cpus?: number;
  /** Guest memory in MB (default: 512). */
  memoryMb?: number;
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    machine?: Partial<Record<string, unknown>>;
  };
}

/** Base64 of a UTF-8 string, the encoding flaps expects in `raw_value`. */
function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/**
 * Create a FlyOtelCollector composite. Returns one Machine.
 *
 * @example
 * ```ts
 * import { App } from "@intentius/chant-lexicon-fly";
 * import { FlyOtelCollector } from "@intentius/chant-lexicon-fly";
 * import { OtlpHttpExporter } from "@intentius/chant-lexicon-otel";
 *
 * export const app = new App({ name: "otel" });
 * export const collector = FlyOtelCollector({
 *   exporters: [new OtlpHttpExporter({ endpoint: "https://otlp.example.com" })],
 * });
 * ```
 */
export const FlyOtelCollector = Composite((props: FlyOtelCollectorProps) => {
  const {
    name = "otel-collector",
    image = COLLECTOR_IMAGE,
    cpuKind = "shared",
    cpus = 1,
    memoryMb = 512,
    defaults: defs,
  } = props;

  const entities = props.config ? [...props.config] : otlpCollector({ exporters: props.exporters, signals: props.signals });
  const { healthCheck } = collectorEndpoints(buildCollectorConfig(entities).config);

  const config = new MachineConfig({
    image,
    init: new MachineInit({ cmd: [`--config=${COLLECTOR_CONFIG_PATH}`] }),
    files: [new File({ guest_path: COLLECTOR_CONFIG_PATH, raw_value: base64(collectorYaml(entities)) })],
    guest: new MachineGuest({ cpu_kind: cpuKind, cpus, memory_mb: memoryMb }),
    restart: new MachineRestart({ policy: "always" }),
    ...(healthCheck
      ? {
          checks: {
            health: new MachineCheck({
              type: "http",
              port: healthCheck.port,
              path: healthCheck.path,
              interval: "15s",
              timeout: "5s",
              grace_period: "10s",
            }),
          },
        }
      : {}),
  });

  const machine = new Machine(mergeDefaults({
    name,
    region: props.region ?? Fly.Region,
    ...(props.app !== undefined ? { app: props.app } : {}),
    config,
  } as Record<string, unknown>, defs?.machine) as ConstructorParameters<typeof Machine>[0]);

  return { machine };
}, "FlyOtelCollector");
