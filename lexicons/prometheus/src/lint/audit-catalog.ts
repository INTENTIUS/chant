/**
 * The prometheus lexicon's chant audit catalog, contributed via
 * `prometheusPlugin.auditCatalog()` (#687, #1346).
 *
 * Every post-synth check reads the emitted rule file or `alertmanager.yml`
 * (or any output document shaped like one), so they are all `yamlBased` and
 * fire on an audit of standalone files too. The three source-level lint rules
 * read TypeScript, so they are constructed with `yamlBased: false`; they are
 * listed for a reader who meets them in a lint report.
 */

import { auditRule, type RuleMeta } from "@intentius/chant/audit/catalog";

function sourceRule(id: string, category: RuleMeta["category"], title: string, remediation: string): RuleMeta {
  return { id, tier: "merge-worthy", fixKind: "guidance", category, title, remediation, yamlBased: false };
}

function outputRule(
  id: string,
  tier: RuleMeta["tier"],
  category: NonNullable<RuleMeta["category"]>,
  title: string,
  remediation: string,
): RuleMeta {
  return auditRule(id, tier, "guidance", title, remediation, { category });
}

export const prometheusAuditCatalog: Record<string, RuleMeta> = {
  PROM001: sourceRule(
    "PROM001",
    "security",
    "Alertmanager credential declared as a literal",
    "Mount the secret as a file and set the field's *_file sibling (api_url_file, routing_key_file, auth_password_file, credentials_file) instead.",
  ),
  PROM002: sourceRule(
    "PROM002",
    "correctness",
    "Literal PromQL expression in a RuleGroup does not parse",
    "Fix the expression at the offset the message names.",
  ),
  PROM003: sourceRule(
    "PROM003",
    "correctness",
    "Slo objective, window or SLI expression is invalid",
    "Set objective strictly between 0 and 1, window to a Prometheus duration such as 28d, and write each SLI expression as PromQL with {{window}} where the range goes.",
  ),
  PROM101: outputRule("PROM101", "merge-worthy", "correctness", "Rule group name repeated in a rule file", "Give every group in the rule file its own name."),
  PROM102: outputRule(
    "PROM102",
    "report-only",
    "correctness",
    "Two rules share a name and label set",
    "Rename one rule, or give the two different labels (for alerts, usually a different severity).",
  ),
  PROM103: outputRule(
    "PROM103",
    "merge-worthy",
    "correctness",
    "Rule or group duration is not a Prometheus duration",
    "Write durations as <number><unit> terms in descending order, e.g. 30s, 5m, 1h30m.",
  ),
  PROM104: outputRule("PROM104", "merge-worthy", "correctness", "Rule expression is not valid PromQL", "Fix the expression at the offset the message names."),
  PROM105: outputRule(
    "PROM105",
    "merge-worthy",
    "correctness",
    "Rule or group is malformed",
    "Set exactly one of record or alert with a non-empty name; keep for, keep_firing_for and annotations to alerting rules.",
  ),
  PROM106: outputRule(
    "PROM106",
    "report-only",
    "best-practice",
    "Alerting rule has no severity label",
    "Add a severity label (on the rule or the group) that an Alertmanager route matches.",
  ),
  PROM107: outputRule(
    "PROM107",
    "report-only",
    "best-practice",
    "Alerting rule has no summary or description",
    "Add a summary annotation saying what is wrong, and a description or runbook_url saying what to do.",
  ),
  PROM201: outputRule("PROM201", "merge-worthy", "correctness", "Route sends to an undeclared receiver", "Declare the receiver, or reference the declared Receiver entity instead of a name string."),
  PROM202: outputRule(
    "PROM202",
    "merge-worthy",
    "correctness",
    "Alert severity not routed by any route",
    "Add a route matching the severity (e.g. severity=\"page\") below the root, or change the alert's severity to one that is routed.",
  ),
  PROM203: outputRule("PROM203", "merge-worthy", "correctness", "Receiver or time interval name repeated", "Give every receiver and every time interval its own name."),
  PROM204: outputRule(
    "PROM204",
    "merge-worthy",
    "correctness",
    "Route names an undeclared time interval",
    "Declare the TimeInterval, or reference the declared entity instead of a name string.",
  ),
  PROM205: outputRule(
    "PROM205",
    "merge-worthy",
    "correctness",
    "Root route missing, without a receiver, or with matchers",
    "Declare exactly one root Route with a receiver and no matchers, and nest every other route under it.",
  ),
  PROM206: outputRule("PROM206", "merge-worthy", "correctness", "Matcher does not parse", 'Write matchers as label, operator and quoted value, e.g. severity="page" or team=~"db|infra".'),
  PROM207: outputRule("PROM207", "report-only", "best-practice", "Receiver declared but never routed to", "Route to the receiver, or remove it."),
  PROM208: outputRule(
    "PROM208",
    "merge-worthy",
    "correctness",
    "Alertmanager duration is not a duration",
    "Write durations as <number><unit> terms in descending order, e.g. 30s, 5m, 4h.",
  ),
  PROM209: outputRule(
    "PROM209",
    "merge-worthy",
    "correctness",
    "Receiver integration missing its destination or credential",
    "Set the integration's url, api_url, routing_key or to/smarthost/from (or their *_file and global equivalents).",
  ),
};
