/**
 * Prior art for the grafana lexicon's audit rules: the tools whose checks cover
 * the same condition, credited per rule. See packages/core/src/audit/prior-art.ts
 * for the registry, the relation vocabulary, and why this is credit rather than
 * authority. Kept by hand.
 *
 * Mapped against grafana/dashboard-linter's rule list (docs/rules/ and
 * lint/rule_*.go, #2916). Its rules are mostly house-style checks on a Grafana
 * dashboard (a templated `datasource` variable, a `job` and `instance`
 * variable, units, panel titles), where chant's GRAF1xx rules check that the
 * dashboard is internally consistent. So only the query-syntax and unit rules
 * line up:
 *
 * - GRAF108 (PromQL): target-promql-rule for panel targets and
 *   template-label-promql-rule for query variables.
 * - GRAF116 (LogQL): target-logql-rule.
 * - GRAF115 (unit): panel-units-rule validates a unit against Grafana's list
 *   and also requires one on stat, graph, table, timeseries and gauge panels;
 *   GRAF115 only rejects an unknown unit, hence "overlaps".
 *
 * No credit, with the nearest upstream rule named so the gap is on record:
 * - GRAF101-GRAF103 (undeclared datasource or variable, type mismatch):
 *   panel-datasource-rule and template-datasource-rule require a templated
 *   datasource variable, a different condition. dashboard-linter does not
 *   resolve a reference to its declaration.
 * - GRAF104, GRAF105, GRAF106 (duplicates, grid, uid and title): no rule.
 *   panel-title-description-rule is about panels, not the dashboard title.
 * - GRAF107 (schema): v2-required-fields-rule checks the top-level fields of a
 *   v2 dashboard spec only; GRAF107 validates a v1 dashboard and every panel's
 *   options against the pinned schema.
 * - GRAF109-GRAF114 (provisioning, repeat, alerting): dashboard-linter reads
 *   dashboard JSON only.
 * - GRAF117 (TraceQL): dashboard-linter has no TraceQL rule.
 */
import type { Lineage } from "@intentius/chant/audit/catalog";

const RULES = "https://github.com/grafana/dashboard-linter/blob/main/docs/rules";

export const grafanaAuditLineage: Record<string, Lineage[]> = {
  GRAF108: [
    { tool: "dashboard-linter", rule: "target-promql-rule", url: `${RULES}/target-promql-rule.md`, relation: "equivalent" },
    { tool: "dashboard-linter", rule: "template-label-promql-rule", url: `${RULES}/template-label-promql-rule.md`, relation: "equivalent" },
  ],
  GRAF115: [{ tool: "dashboard-linter", rule: "panel-units-rule", url: `${RULES}/panel-units-rule.md`, relation: "overlaps" }],
  GRAF116: [{ tool: "dashboard-linter", rule: "target-logql-rule", url: `${RULES}/target-logql-rule.md`, relation: "equivalent" }],
};
