/**
 * A collector config embedded in another lexicon's resource, e.g. the
 * `config.yaml` of a k8s ConfigMap, for `chant import` (#2962).
 *
 * The config is imported exactly as `chant import config.yaml` would import
 * it, into a directory of its own, and the host's value becomes
 * `collectorYaml([...])` over every component, pipeline and service the
 * import declares, which renders the same config text at build time.
 *
 * A host that holds the config as an object, the OpenTelemetry Operator's
 * `OpenTelemetryCollector` `spec.config`, offers it as `{ config, header }`
 * with `select: "config"`. The config is printed back to the text the
 * standalone import reads, with the `# chant:` header lines the host kept in
 * an annotation put back on top so custom-component pins and semconv use
 * survive. The host's value becomes `collectorConfig([...])`, an object, so
 * the field keeps the type its CRD gives it.
 */

import type { EmbeddedContent, EmbeddedContentImporter, EmbeddedImport } from "@intentius/chant/import/embedded";
import { exportedNames } from "@intentius/chant/import/embedded";
import { looksLikeCollectorConfig, type CollectorConfig } from "../model";
import { emitCollectorYaml } from "../yaml";
import { OtelCollectorParser } from "./parser";
import { OtelCollectorGenerator } from "./generator";

const PACKAGE = "@intentius/chant-lexicon-otel";

/** The module holding `defineComponent` classes: types, not config entities. */
const CUSTOM_COMPONENTS = "custom-components.ts";

function selectedConfig(content: EmbeddedContent): unknown {
  const doc = content.document;
  return typeof doc === "object" && doc !== null ? (doc as { config?: unknown }).config : undefined;
}

/** The text a `{ config, header }` document prints as: the header lines as comments, then the config. */
function objectConfigText(content: EmbeddedContent): string {
  const header = (content.document as { header?: unknown }).header;
  const lines = Array.isArray(header) ? header.filter((l): l is string => typeof l === "string") : [];
  return emitCollectorYaml(selectedConfig(content) as CollectorConfig, { header: lines });
}

export const collectorConfigImporter: EmbeddedContentImporter = {
  what: "an OpenTelemetry Collector config",

  matches(content) {
    if (content.select === "config") return looksLikeCollectorConfig(selectedConfig(content));
    return typeof content.text === "string" && content.select === undefined && looksLikeCollectorConfig(content.document);
  },

  import(content): EmbeddedImport {
    const asObject = content.select === "config";
    const text = asObject ? objectConfigText(content) : content.text!;
    const ir = new OtelCollectorParser().parse(text);
    const files = new OtelCollectorGenerator().generate(ir);
    const bindings = files
      .filter((f) => f.path !== CUSTOM_COMPONENTS)
      .flatMap((f) => exportedNames(f.content).map((name) => ({ from: f.path, name })));
    return {
      files,
      value: { bindings, shape: "list", through: { from: PACKAGE, name: asObject ? "collectorConfig" : "collectorYaml" } },
      warnings: ir.warnings ?? [],
    };
  },
};
