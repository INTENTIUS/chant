/**
 * A collector config embedded in another lexicon's resource, e.g. the
 * `config.yaml` of a k8s ConfigMap, for `chant import` (#2962).
 *
 * The config is imported exactly as `chant import config.yaml` would import
 * it, into a directory of its own, and the host's value becomes
 * `collectorYaml([...])` over every component, pipeline and service the
 * import declares, which renders the same config text at build time.
 */

import type { EmbeddedContentImporter, EmbeddedImport } from "@intentius/chant/import/embedded";
import { exportedNames } from "@intentius/chant/import/embedded";
import { looksLikeCollectorConfig } from "../model";
import { OtelCollectorParser } from "./parser";
import { OtelCollectorGenerator } from "./generator";

const PACKAGE = "@intentius/chant-lexicon-otel";

/** The module holding `defineComponent` classes: types, not config entities. */
const CUSTOM_COMPONENTS = "custom-components.ts";

export const collectorConfigImporter: EmbeddedContentImporter = {
  what: "an OpenTelemetry Collector config",

  matches(content) {
    return typeof content.text === "string" && content.select === undefined && looksLikeCollectorConfig(content.document);
  },

  import(content): EmbeddedImport {
    const ir = new OtelCollectorParser().parse(content.text!);
    const files = new OtelCollectorGenerator().generate(ir);
    const bindings = files
      .filter((f) => f.path !== CUSTOM_COMPONENTS)
      .flatMap((f) => exportedNames(f.content).map((name) => ({ from: f.path, name })));
    return {
      files,
      value: { bindings, shape: "list", through: { from: PACKAGE, name: "collectorYaml" } },
      warnings: ir.warnings ?? [],
    };
  },
};
