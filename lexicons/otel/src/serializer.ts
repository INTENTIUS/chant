/**
 * OpenTelemetry Collector serializer.
 *
 * Emits one collector config file from every otel entity in the build: the
 * YAML `otelcol --config` reads as it is. Section order is fixed (receivers,
 * processors, exporters, connectors, extensions, service); components and pipelines keep
 * the order they are declared in, and each component's config keeps the key
 * order it was written in, since collector docs and diffs read that way.
 *
 * A project that declares a `Distribution` also gets the ocb builder manifest,
 * as `builder-config.yaml` beside the config (see `distribution.ts`).
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
import { DISTRIBUTION_MANIFEST_FILE, distributionYaml, isDistributionEntity } from "./distribution";

export const otelSerializer: Serializer = {
  name: "otel",
  rulePrefix: "OTEL",

  serialize(entities: Map<string, Declarable>, _outputs?: LexiconOutput[]): string | SerializerResult {
    const built = buildCollectorConfig(entities);
    const yaml = emitCollectorYaml(built.config, { header: built.header });
    const warnings = [...built.warnings];
    // A declared Distribution (#3374) adds the ocb builder manifest beside the config.
    const distributions = [...entities.values()].filter(isDistributionEntity);
    if (distributions.length > 1) warnings.push("otel: more than one Distribution is declared; the first one is written");
    const files = distributions.length > 0 ? { [DISTRIBUTION_MANIFEST_FILE]: distributionYaml(distributions[0]) } : undefined;
    if (warnings.length === 0 && !files) return yaml;
    return { primary: yaml, ...(files ? { files } : {}), ...(warnings.length > 0 ? { warnings } : {}) };
  },
};
