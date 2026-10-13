/**
 * Template detection for the otel lexicon: a parsed document is a collector
 * config when it has `service.pipelines` and a receivers or exporters
 * section. Kept free of the plugin and the TypeScript compiler so it bundles
 * for edge runtimes, like the other lexicons' `detect` modules.
 */
import { looksLikeCollectorConfig } from "./model";

export function detectTemplate(data: unknown): boolean {
  return looksLikeCollectorConfig(data) || isObjectConfigOffer(data);
}

/**
 * The `{ config, header }` document a host offers for a config it holds as an
 * object, such as an OpenTelemetryCollector's `spec.config` (#3367). `chant
 * import` asks this module which lexicons own what a host offered, so the
 * wrapper has to be recognised here as well as by the importer.
 */
function isObjectConfigOffer(data: unknown): boolean {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const keys = Object.keys(data);
  return keys.includes("config") && keys.every((k) => k === "config" || k === "header") && looksLikeCollectorConfig((data as { config?: unknown }).config);
}
