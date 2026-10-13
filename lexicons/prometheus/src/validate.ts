/**
 * Validate the prometheus lexicon's own artifacts: every class is in the
 * registry, every entity constructs and serializes, and a sample rule file
 * and Alertmanager config pass the lexicon's own checks, and `promtool check
 * config` accepts a sample `prometheus.yml` when `promtool` is installed.
 */

import type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";
import { CATALOG, lexiconRegistry } from "./catalog";
import { RuleGroup } from "./rules";
import { AlertmanagerSettings, InhibitRule, Receiver, Route, TimeInterval } from "./alertmanager";
import { buildAlertmanagerConfig, buildRuleFile, prometheusConfigYaml, ruleFileYaml } from "./build";
import { PrometheusConfig, ScrapeConfig } from "./prometheus-config";
import { hasTool, promtoolCheckConfig } from "./tools";
import { validateAlertmanagerConfig, validateRuleFile } from "./validate-config";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

/** Every entity class the package must keep exporting. */
export const REQUIRED_NAMES = ["RuleGroup", "ScrapeConfig", "PrometheusConfig", "Route", "Receiver", "InhibitRule", "TimeInterval", "AlertmanagerSettings"];

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

  // `promtool check config` over a sample prometheus.yml, with the rule file it names beside it.
  const promtool = process.env.PROMTOOL ?? "promtool";
  if (!hasTool(promtool)) {
    checks.push({ name: `promtool-check-config (skipped: ${promtool} is not installed)`, ok: true });
  } else {
    const config = prometheusConfigYaml([
      new PrometheusConfig({
        global: { scrape_interval: "15s", evaluation_interval: "30s" },
        rule_files: ["rules.yml"],
        alerting: { alertmanagers: [{ static_configs: [{ targets: ["alertmanager:9093"] }] }] },
      }),
      new ScrapeConfig({ job_name: "prometheus", static_configs: [{ targets: ["localhost:9090"] }] }),
    ]);
    const r = promtoolCheckConfig(config, { "rules.yml": ruleFileYaml([group]) }, promtool);
    checks.push(
      r.ok
        ? { name: "promtool-check-config", ok: true }
        : { name: "promtool-check-config", ok: false, error: r.output.trim() || "promtool check config failed" },
    );
  }

  return { success: checks.every((c) => c.ok), checks };
}
