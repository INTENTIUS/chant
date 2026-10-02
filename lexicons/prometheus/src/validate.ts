/**
 * Validate the prometheus lexicon's own artifacts: every class is in the
 * registry, every entity constructs and serializes, and a sample rule file
 * and Alertmanager config pass the lexicon's own checks.
 */

import type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";
import { CATALOG, lexiconRegistry } from "./catalog";
import { RuleGroup } from "./rules";
import { AlertmanagerSettings, InhibitRule, Receiver, Route, TimeInterval } from "./alertmanager";
import { buildAlertmanagerConfig, buildRuleFile } from "./build";
import { validateAlertmanagerConfig, validateRuleFile } from "./validate-config";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

/** Every entity class the package must keep exporting. */
export const REQUIRED_NAMES = ["RuleGroup", "Route", "Receiver", "InhibitRule", "TimeInterval", "AlertmanagerSettings"];

export async function validate(): Promise<ValidateResult> {
  const checks: ValidateCheck[] = [];
  const registry = lexiconRegistry();

  const missing = REQUIRED_NAMES.filter((n) => !(n in registry));
  checks.push(
    missing.length === 0
      ? { name: "required-names", ok: true }
      : { name: "required-names", ok: false, error: `Missing required names: ${missing.join(", ")}` },
  );

  checks.push(
    CATALOG.length === Object.keys(registry).length
      ? { name: "catalog-matches-registry", ok: true }
      : { name: "catalog-matches-registry", ok: false, error: "catalog and registry disagree" },
  );

  const group = new RuleGroup({
    name: "sample",
    interval: "30s",
    rules: [
      { record: "job:up:sum", expr: "sum by (job) (up)" },
      { alert: "TargetDown", expr: "up == 0", for: "5m", labels: { severity: "page" }, annotations: { summary: "a target is down" } },
    ],
  });
  const ruleIssues = validateRuleFile(buildRuleFile([group]).config);
  checks.push(
    ruleIssues.length === 0
      ? { name: "rule-file-roundtrip", ok: true }
      : { name: "rule-file-roundtrip", ok: false, error: ruleIssues.map((i) => i.message).join("; ") },
  );

  const hook = new Receiver({ name: "hook", webhook_configs: [{ url: "http://hook:8080/" }] });
  const quiet = new TimeInterval({ name: "weekend", time_intervals: [{ weekdays: ["saturday", "sunday"] }] });
  const entities = [
    new AlertmanagerSettings({ global: { resolve_timeout: "5m" } }),
    new Route({ receiver: hook, routes: [{ matchers: ['severity="page"'], receiver: hook, mute_time_intervals: [quiet] }] }),
    new InhibitRule({ source_matchers: ['severity="page"'], target_matchers: ['severity="ticket"'], equal: ["alertname"] }),
  ];
  const amIssues = validateAlertmanagerConfig(buildAlertmanagerConfig(entities).config);
  checks.push(
    amIssues.length === 0
      ? { name: "alertmanager-roundtrip", ok: true }
      : { name: "alertmanager-roundtrip", ok: false, error: amIssues.map((i) => i.message).join("; ") },
  );

  return { success: checks.every((c) => c.ok), checks };
}
