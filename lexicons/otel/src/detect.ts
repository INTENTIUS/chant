/**
 * Template detection for the otel lexicon: a parsed document is a collector
 * config when it has `service.pipelines` and a receivers or exporters
 * section. Kept free of the plugin and the TypeScript compiler so it bundles
 * for edge runtimes, like the other lexicons' `detect` modules.
 */
import { looksLikeCollectorConfig } from "./model";

export function detectTemplate(data: unknown): boolean {
  return looksLikeCollectorConfig(data);
}
