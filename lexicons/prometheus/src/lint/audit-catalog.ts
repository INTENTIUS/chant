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

import { applyLineage, auditRule, type RuleMeta } from "@intentius/chant/audit/catalog";
import { prometheusAuditLineage } from "./audit-lineage";

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
    "Set the integration's destination and credential (url, webhook_url, api_key, routing_key, chat_id, room_id, to/smarthost/from, ...), through its *_file or global equivalent where there is one.",
  ),
  PROM210: outputRule(
    "PROM210",
    "merge-worthy",
    "correctness",
    "Integration or global setting Alertmanager rejects",
    "Set one of each value and its *_file, and use a value Alertmanager allows (e.g. message_type text or markdown, parse_mode Markdown, MarkdownV2 or HTML).",
  ),
  PROM211: outputRule(
    "PROM211",
    "report-only",
    "best-practice",
    "Alerting rule has no for, or for: 0s",
    "Set for to how long the condition must hold before the alert fires, e.g. 5m.",
  ),
  PROM212: outputRule(
    "PROM212",
    "report-only",
    "best-practice",
    "Alerting rule has no runbook_url annotation (opt-in)",
    "Add a runbook_url annotation linking to what the responder should do.",
  ),
  PROM213: outputRule(
    "PROM213",
    "merge-worthy",
    "correctness",
    "Alert expression has no comparison",
    "Add the condition the alert fires on, e.g. > 0.05, or use absent() for a missing series.",
  ),
  PROM214: outputRule(
    "PROM214",
    "merge-worthy",
    "correctness",
    "Alert template reads a label the expression aggregates away",
    "Keep the label in the aggregation's by (...), or stop reading it in the template.",
  ),
  PROM215: outputRule(
    "PROM215",
    "merge-worthy",
    "correctness",
    "rate, irate or increase over a name that is not a counter's",
    "Read a counter (a name ending in _total, _count, _sum or _bucket), or use delta() or deriv() for a gauge.",
  ),
  PROM216: outputRule(
    "PROM216",
    "merge-worthy",
    "correctness",
    "histogram_quantile over a series without _bucket, or without le",
    "Pass the histogram's _bucket series, and keep le in the aggregation: sum by (le, ...) (rate(x_bucket[5m])).",
  ),
  PROM217: outputRule(
    "PROM217",
    "report-only",
    "best-practice",
    "Recording rule name is not level:metric:operations",
    "Name the recorded series level:metric:operations, e.g. job:http_requests:rate5m.",
  ),
  PROM218: outputRule(
    "PROM218",
    "report-only",
    "best-practice",
    "Regex matcher needs no regex, or is anchored",
    'Use = or != for a plain value, and drop ^ and $ from a regex, which Prometheus anchors already (job=~"api|web").',
  ),
  PROM219: outputRule("PROM219", "merge-worthy", "correctness", "Alerting rule sets the alertname label", "Remove the alertname label; rename the rule instead."),
  PROM220: outputRule(
    "PROM220",
    "merge-worthy",
    "security",
    "Receiver turns off TLS certificate verification",
    "Remove insecure_skip_verify, and set ca_file to the CA that signed the endpoint's certificate.",
  ),
  PROM221: outputRule(
    "PROM221",
    "merge-worthy",
    "security",
    "SMTP credentials sent with require_tls false",
    "Set require_tls (or global.smtp_require_tls) to true, or use force_implicit_tls with an SMTPS port.",
  ),
  PROM222: outputRule(
    "PROM222",
    "merge-worthy",
    "security",
    "Credentials sent to an http:// receiver URL",
    "Point the integration at an https:// URL.",
  ),
  PROM223: outputRule(
    "PROM223",
    "merge-worthy",
    "correctness",
    "repeat_interval is shorter than group_interval",
    "Set repeat_interval to a multiple of group_interval, or lower group_interval.",
  ),
  PROM224: outputRule(
    "PROM224",
    "merge-worthy",
    "correctness",
    "Inhibit rule matches one alert as source and target, with no equal",
    "List the labels source and target must share under equal (e.g. alertname, cluster), or make the matchers exclusive.",
  ),
};

/** Post-synth checks the `recommended` lint preset leaves out (#3363); see `prometheusPlugin.lintPresets()`. */
export const OPT_IN_CHECKS: ReadonlySet<string> = new Set(["PROM212"]);

// Prior art credits live beside the rules in ./audit-lineage.ts (see core audit/prior-art.ts).
applyLineage(prometheusAuditCatalog, prometheusAuditLineage);
