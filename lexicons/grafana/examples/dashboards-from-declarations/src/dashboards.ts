/**
 * Three dashboards, each built from the declaration it reads: RED per
 * service from the spanmetrics connector, the checkout SLO from its `Slo`,
 * and agent calls, errors and tokens from the GenAI preset.
 */
import { AgentDashboard, RedDashboard, SloDashboard } from "@intentius/chant-lexicon-grafana";
import { genai, metricsEndpoint, spans } from "./components";
import { prometheus } from "./datasources";
import { checkout } from "./slo";

const services = RedDashboard({ spanMetrics: spans, exporter: metricsEndpoint, datasource: prometheus, folder: "Observability" });

const checkoutSlo = SloDashboard({ slo: checkout, datasource: prometheus, folder: "Observability" });

const agents = AgentDashboard({ genAi: genai, datasource: prometheus, folder: "Observability" });

export { services, checkoutSlo, agents };
