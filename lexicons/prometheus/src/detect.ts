/**
 * Template detection for the prometheus lexicon: a parsed document is ours
 * when it is shaped like a rule file (`groups:` of named rule lists), an
 * `alertmanager.yml` (`route:` or `receivers:` at the top level) or a
 * `prometheus.yml` (`scrape_configs:`, `remote_write:` and the like). Kept free
 * of the plugin and the TypeScript compiler so it bundles for edge runtimes,
 * like the other lexicons' `detect` modules.
 */
import { looksLikeAlertmanagerConfig, looksLikePrometheusConfig, looksLikeRuleFile } from "./model";

export function detectTemplate(data: unknown): boolean {
  return looksLikeRuleFile(data) || looksLikeAlertmanagerConfig(data) || looksLikePrometheusConfig(data);
}
