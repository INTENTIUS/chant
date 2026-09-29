/**
 * Grafana lexicon composites: dashboards built from the declarations they
 * read, so renaming a metric at its source moves it in the panels.
 */

export { RedDashboard, redQueries, RED_DEFAULT_SPAN_KINDS } from "./red-dashboard";
export type { RedDashboardProps, RedDashboardMembers, RedDashboardInstance, SpanKind } from "./red-dashboard";
export { SloDashboard, sloQueries } from "./slo-dashboard";
export type { SloDashboardProps, SloDashboardMembers, SloDashboardInstance } from "./slo-dashboard";
export { AgentDashboard, agentQueries } from "./agent-dashboard";
export type { AgentDashboardProps, AgentDashboardMembers, AgentDashboardInstance } from "./agent-dashboard";
export type { DashboardOptions } from "./shared";
export { SloAlertRules, sloAlertQueries } from "./slo-alert-rules";
export type { SloAlertRulesProps, SloAlertRulesMembers, SloAlertRulesInstance } from "./slo-alert-rules";
