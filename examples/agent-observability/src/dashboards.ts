/**
 * Three dashboards, each built from the declaration it reads, so renaming a
 * metric at its source moves the panels with it:
 *
 * - RED per service, from the gateway's `spanmetrics` connector and the
 *   `prometheus` exporter that serves it;
 * - the agent SLO, from its `Slo`: error ratios per window, the budget left,
 *   and each burn-rate pair against its threshold;
 * - the agent itself, from the GenAI preset: calls, errors and latency per
 *   operation, model and tool, and token usage per model.
 */
import { AgentDashboard, RedDashboard, SloDashboard } from "@intentius/chant-lexicon-grafana";
import { red, genai } from "./gateway-metrics";
import { scrapeEndpoint } from "./gateway-components";
import { prometheusDatasource } from "./datasources";
import { agentRuns } from "./slo";

const FOLDER = "Agent observability";

const services = RedDashboard({ spanMetrics: red, exporter: scrapeEndpoint, datasource: prometheusDatasource, folder: FOLDER });

const agentSlo = SloDashboard({ slo: agentRuns, datasource: prometheusDatasource, folder: FOLDER });

const agentCalls = AgentDashboard({ genAi: genai, datasource: prometheusDatasource, folder: FOLDER });

export { services, agentSlo, agentCalls };
