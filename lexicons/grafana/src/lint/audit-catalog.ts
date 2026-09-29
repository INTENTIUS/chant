/**
 * The grafana lexicon's chant audit catalog, contributed via
 * `grafanaPlugin.auditCatalog()` (#687, #1346).
 *
 * GRAF101-GRAF108 and GRAF111-GRAF114 read the emitted dashboard JSON and
 * provisioning files (alerting included), so
 * they fire on an audit of files chant didn't build too, and are
 * `yamlBased`. GRAF001 and GRAF002 read TypeScript source, so they are
 * constructed with `yamlBased: false`; they are listed for a reader who
 * meets them in a lint report.
 */

import { auditRule, type RuleMeta } from "@intentius/chant/audit/catalog";

function sourceRule(id: string, category: RuleMeta["category"], title: string, remediation: string): RuleMeta {
  return { id, tier: "merge-worthy", fixKind: "guidance", category, title, remediation, yamlBased: false };
}

export const grafanaAuditCatalog: Record<string, RuleMeta> = {
  GRAF001: sourceRule(
    "GRAF001",
    "correctness",
    "Grafana uid or variable name is not valid syntax",
    'Use 1-40 letters, digits, "-" and "_" for uids, and letters, digits and "_" for variable names.',
  ),
  GRAF002: sourceRule(
    "GRAF002",
    "security",
    "Datasource or contact point secret declared as a literal",
    "Replace the value with `$__env{NAME}` or `$__file{/path}` so Grafana reads it when it loads the provisioning file.",
  ),
  GRAF101: auditRule(
    "GRAF101",
    "merge-worthy",
    "guidance",
    "Panel uses an undeclared datasource",
    "Point the panel or query at a declared Datasource, or declare the datasource it names in the same build root: a Datasource to provision it, an ExternalDatasource if it already exists in Grafana.",
    { category: "correctness" },
  ),
  GRAF102: auditRule(
    "GRAF102",
    "merge-worthy",
    "guidance",
    "Query sent to a datasource of another type",
    "Use the query class that matches the datasource (PromQuery for prometheus, TempoQuery for tempo, LokiQuery for loki), or point the query at a datasource of its own type.",
    { category: "correctness" },
  ),
  GRAF103: auditRule(
    "GRAF103",
    "merge-worthy",
    "guidance",
    "Query uses an undeclared dashboard variable",
    "Declare the variable and list it in the dashboard's variables, or remove the reference.",
    { category: "correctness" },
  ),
  GRAF104: auditRule(
    "GRAF104",
    "merge-worthy",
    "guidance",
    "Duplicate dashboard uid, datasource, panel id, variable or refId",
    "Give each dashboard and datasource its own uid and name, and each panel, variable and query its own id within its dashboard or panel.",
    { category: "correctness" },
  ),
  GRAF105: auditRule(
    "GRAF105",
    "report-only",
    "guidance",
    "Panel outside the grid or overlapping another",
    "Keep x + w within 24 columns, and move or resize overlapping panels, or leave x and y out so the dashboard places them.",
    { category: "best-practice" },
  ),
  GRAF106: auditRule(
    "GRAF106",
    "merge-worthy",
    "guidance",
    "Dashboard or datasource uid Grafana rejects, or an untitled dashboard",
    'Use 1-40 letters, digits, "-" and "_" for uids, and give every dashboard a title.',
    { category: "correctness" },
  ),
  GRAF107: auditRule(
    "GRAF107",
    "merge-worthy",
    "guidance",
    "Dashboard does not match the Grafana schema",
    "Fix the key or value the message names; the panel option types generated from the same schema show what is allowed.",
    { category: "correctness" },
  ),
  GRAF108: auditRule(
    "GRAF108",
    "merge-worthy",
    "guidance",
    "Query sent to Prometheus is not valid PromQL",
    "Fix the expression at the offset the message names: an unbalanced bracket or quote, a bad range duration, a missing operator. Template variables are substituted before the check, so $var, ${var} and $__rate_interval are fine where Grafana accepts them.",
    { category: "correctness" },
  ),
  GRAF111: auditRule(
    "GRAF111",
    "merge-worthy",
    "guidance",
    "Alert rule condition, expression input or refId does not fit the rule's queries",
    "Point the condition, each expression's input and record.from at a refId the rule has, give each query its own refId, and fix the expression field the message names.",
    { category: "correctness" },
  ),
  GRAF112: auditRule(
    "GRAF112",
    "merge-worthy",
    "guidance",
    "Alert rule queries an undeclared datasource, or one of another type",
    "Pass a declared Datasource or ExternalDatasource as the query's datasource, of the type its model is for.",
    { category: "correctness" },
  ),
  GRAF113: auditRule(
    "GRAF113",
    "merge-worthy",
    "guidance",
    "Alerting routes to an undeclared contact point or mute timing, or a matcher does not parse",
    "Declare the ContactPoint or MuteTiming (or pass the entity itself rather than its name), and write matchers as [label, op, value] with op =, !=, =~ or !~.",
    { category: "correctness" },
  ),
  GRAF114: auditRule(
    "GRAF114",
    "merge-worthy",
    "guidance",
    "Alerting uid, name, title or interval Grafana rejects, or declared twice",
    'Use 1-40 letters, digits, "-" and "_" for uids, a multiple of 10s for group intervals, and one name per rule group, contact point, mute timing and template in each organisation.',
    { category: "correctness" },
  ),
};
