/**
 * Grafana lexicon composites: dashboards built from the declarations they
 * read, so renaming a metric at its source moves it in the panels.
 */

export { RedDashboard, redQueries } from "./red-dashboard";
export type { RedDashboardProps, RedDashboardMembers, RedDashboardInstance } from "./red-dashboard";
export { SloDashboard, sloQueries } from "./slo-dashboard";
export type { SloDashboardProps, SloDashboardMembers, SloDashboardInstance } from "./slo-dashboard";
export { AgentDashboard, agentQueries } from "./agent-dashboard";
export type { AgentDashboardProps, AgentDashboardMembers, AgentDashboardInstance } from "./agent-dashboard";
export type { DashboardOptions } from "./shared";
