/**
 * Prometheus serializer.
 *
 * Emits the two files a Prometheus setup reads:
 *
 * - the rule file (`groups:`), from every `RuleGroup` in the build, the file
 *   `rule_files:` points at and `promtool check rules` reads;
 * - `alertmanager.yml`, from the `Route`, `Receiver`, `InhibitRule`,
 *   `TimeInterval` and `AlertmanagerSettings` entities, the file
 *   `amtool check-config` reads.
 *
 * The rule file is the primary output when the build declares any rule
 * groups, and `alertmanager.yml` is written beside it when the build also
 * declares Alertmanager entities. A build with only Alertmanager entities
 * emits `alertmanager.yml` as the primary output. Rules inside a group and
 * child routes keep the order they are written in, which is the order that
 * matters to Prometheus and Alertmanager; groups, receivers and time
 * intervals, whose order means nothing, are sorted by name.
 *
 * Neither file has a metadata channel, so there is no ownership marker to
 * stamp.
 */

import type { Declarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { buildAlertmanagerConfig, buildRuleFile, emitYaml } from "./build";

/** The filename `alertmanager.yml` is written under when it sits beside a rule file. */
export const ALERTMANAGER_FILE = "alertmanager.yml";

export const prometheusSerializer: Serializer = {
  name: "prometheus",
  rulePrefix: "PROM",

  serialize(entities: Map<string, Declarable>, _outputs?: LexiconOutput[]): string | SerializerResult {
    const rules = buildRuleFile(entities);
    const am = buildAlertmanagerConfig(entities);
    const hasRules = rules.groups.length > 0;
    const hasAm = am.count > 0;
    const warnings = am.warnings;

    if (!hasRules && !hasAm) return "";
    if (!hasAm) return emitYaml(rules.config);
    if (!hasRules) {
      const text = emitYaml(am.config);
      return warnings.length === 0 ? text : { primary: text, warnings };
    }
    return {
      primary: emitYaml(rules.config),
      files: { [ALERTMANAGER_FILE]: emitYaml(am.config) },
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};
