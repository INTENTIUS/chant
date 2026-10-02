/**
 * Four dashboards, each built from the declaration it reads: RED per
 * service from the spanmetrics connector, the checkout SLO from its `Slo`,
 * agent calls, errors and tokens from the GenAI preset, and the same per
 * provider with cost from the GenAI recording rules.
 */
import { AgentDashboard, RedDashboard, SloDashboard } from "@intentius/chant-lexicon-grafana";
import { genai, metricsEndpoint, spans } from "./components";
import { prometheus } from "./datasources";
import { genaiRules } from "./genai-rules";
import { checkout } from "./slo";

const services = RedDashboard({ spanMetrics: spans, exporter: metricsEndpoint, datasource: prometheus, folder: "Observability" });

const checkoutSlo = SloDashboard({ slo: checkout, datasource: prometheus, folder: "Observability" });

const agents = AgentDashboard({ genAi: genai, datasource: prometheus, folder: "Observability" });

const agentCost = AgentDashboard({ rules: genaiRules, datasource: prometheus, folder: "Observability" });

export { services, checkoutSlo, agents, agentCost };
