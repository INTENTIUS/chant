/**
 * The generated Grafana schema types, one namespace per vendored schema.
 * `schema.stat.Options` is the stat panel's options exactly as Grafana's
 * schema at `GRAFANA_SCHEMA_PIN` spells them.
 */
export * as dashboard from "./dashboard.gen";
export * as timeseries from "./timeseries.gen";
export * as stat from "./stat.gen";
export * as gauge from "./gauge.gen";
export * as table from "./table.gen";
export * as logs from "./logs.gen";
export * as heatmap from "./heatmap.gen";
export * as text from "./text.gen";
export * as prometheus from "./prometheus.gen";
export * as tempo from "./tempo.gen";
export * as loki from "./loki.gen";
export { DASHBOARD_SCHEMA_VERSION } from "./dashboard.gen";
