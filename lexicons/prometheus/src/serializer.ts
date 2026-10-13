/**
 * Prometheus serializer.
 *
 * Emits the files a Prometheus setup reads:
 *
 * - the rule file (`groups:`), from every `RuleGroup` in the build, the file
 *   `rule_files:` points at and `promtool check rules` reads;
 * - `prometheus.yml`, from the `PrometheusConfig` and `ScrapeConfig`
 *   entities, the file `promtool check config` reads;
 * - `alertmanager.yml`, from the `Route`, `Receiver`, `InhibitRule`,
 *   `TimeInterval` and `AlertmanagerSettings` entities, the file
 *   `amtool check-config` reads.
 *
 * The first of those a build produces, in that order, is the primary output
 * and the others are written beside it: the rule file, then `prometheus.yml`
 * (`PROMETHEUS_FILE`), then `alertmanager.yml`. A project that declares only
 * rule groups, or only Alertmanager entities, sees no change. Rules inside a
 * group and child routes keep the order they are written in, which is the
 * order that matters to Prometheus and Alertmanager; groups, scrape jobs,
 * receivers and time intervals, whose order means nothing, are sorted by name.
 *
 * None of these files has a metadata channel, so there is no ownership marker
 * to stamp.
 */

import type { Declarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { buildAlertmanagerConfig, buildPrometheusConfig, buildRuleFile, emitYaml } from "./build";

/** The filename `prometheus.yml` is written under when it sits beside a rule file or `alertmanager.yml`. */
export const PROMETHEUS_FILE = "prometheus.yml";

/** The filename `alertmanager.yml` is written under when it sits beside a rule file. */
export const ALERTMANAGER_FILE = "alertmanager.yml";

export const prometheusSerializer: Serializer = {
  name: "prometheus",
  rulePrefix: "PROM",

  serialize(entities: Map<string, Declarable>, _outputs?: LexiconOutput[]): string | SerializerResult {
    const rules = buildRuleFile(entities);
    const prom = buildPrometheusConfig(entities);
    const am = buildAlertmanagerConfig(entities);
    const warnings = [...prom.warnings, ...am.warnings];

    // The files this build writes, in the order of the primary: the rule file,
    // then prometheus.yml, then alertmanager.yml.
    const out: Array<[string, string]> = [];
    if (rules.groups.length > 0) out.push(["rules", emitYaml(rules.config)]);
    if (prom.count > 0) out.push([PROMETHEUS_FILE, emitYaml(prom.config)]);
    if (am.count > 0) out.push([ALERTMANAGER_FILE, emitYaml(am.config)]);

    if (out.length === 0) return "";
    if (out.length === 1) {
      return warnings.length === 0 ? out[0][1] : { primary: out[0][1], warnings };
    }
    const [[, primary], ...rest] = out;
    return {
      primary,
      files: Object.fromEntries(rest),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};
