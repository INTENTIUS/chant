/**
 * The top of the dashboard: what the service is doing right now. Panels
 * without a gridPos are placed left to right in declaration order.
 */
import { TextPanel, StatPanel, GaugePanel, TimeSeriesPanel } from "@intentius/chant-lexicon-grafana";
import { prometheus } from "./datasources";
import { requestRate, errorRatio, latencyP95 } from "./queries";

const introText = {
  mode: "markdown" as const,
  content: "Request rate, errors and latency for **$service**, from span metrics, with its slowest traces and logs below.",
};
const intro = new TextPanel({ title: "About", options: introText });

const percent = { unit: "percentunit", decimals: 2 };
const asPercent = { defaults: percent };
const errorStat = { graphMode: "area" as const, colorMode: "background" as const };
const errors = new StatPanel({
  title: "Error ratio",
  datasource: prometheus,
  targets: [errorRatio],
  options: errorStat,
  fieldConfig: asPercent,
});

const errorSteps = [
  { value: null, color: "green" },
  { value: 0.01, color: "orange" },
  { value: 0.05, color: "red" },
];
const errorScale = { ...percent, min: 0, max: 0.1, thresholds: { mode: "absolute" as const, steps: errorSteps } };
const againstBudget = { defaults: errorScale };
const errorGauge = new GaugePanel({
  title: "Error ratio against 5%",
  datasource: prometheus,
  targets: [errorRatio],
  fieldConfig: againstBudget,
});

const bars = { drawStyle: "bars" as const, fillOpacity: 60 };
const perSecondBars = { defaults: { unit: "reqps", custom: bars } };
const rate = new TimeSeriesPanel({
  title: "Requests per second by operation",
  datasource: prometheus,
  targets: [requestRate],
  fieldConfig: perSecondBars,
});

const milliseconds = { defaults: { unit: "ms" } };
const latency = new TimeSeriesPanel({
  title: "Latency p95",
  datasource: prometheus,
  targets: [latencyP95],
  fieldConfig: milliseconds,
});

export { intro, errors, errorGauge, rate, latency };
