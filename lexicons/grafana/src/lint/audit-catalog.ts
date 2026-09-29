/**
 * The grafana lexicon's chant audit catalog, contributed via
 * `grafanaPlugin.auditCatalog()` (#687, #1346).
 *
 * GRAF101-GRAF107 read the emitted dashboard JSON and provisioning files, so
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
    "Datasource secret declared as a literal",
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
};
