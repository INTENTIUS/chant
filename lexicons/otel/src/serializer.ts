/**
 * OpenTelemetry Collector serializer.
 *
 * Emits one collector config file from every otel entity in the build: the
 * YAML `otelcol --config` reads as it is. Section order is fixed (receivers,
 * processors, exporters, extensions, service); components and pipelines keep
 * the order they are declared in, and each component's config keeps the key
 * order it was written in, since collector docs and diffs read that way.
 *
 * A collector config has no metadata channel, so there is no ownership marker
 * to stamp. A custom component's schema pin is written as a `# chant:` comment
 * line above the config (see `define.ts`).
 */

import type { Declarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { buildCollectorConfig } from "./collector";
import { emitCollectorYaml } from "./yaml";

export const otelSerializer: Serializer = {
  name: "otel",
  rulePrefix: "OTEL",

  serialize(entities: Map<string, Declarable>, _outputs?: LexiconOutput[]): string | SerializerResult {
    const built = buildCollectorConfig(entities);
    const yaml = emitCollectorYaml(built.config, { header: built.header });
    if (built.warnings.length === 0) return yaml;
    return { primary: yaml, warnings: built.warnings };
  },
};
