/**
 * The bottom of the dashboard: where the time goes, which requests were
 * slow, and what the service logged.
 */
import { HeatmapPanel, TablePanel, LogsPanel, TracesPanel } from "@intentius/chant-lexicon-grafana";
import { prometheus, tempo, loki } from "./datasources";
import { latencyBuckets, slowTraces, traceById, serviceLogs } from "./queries";

const heatmapCells = { calculate: false, yAxis: { unit: "ms" } };
const latencyDistribution = new HeatmapPanel({
  title: "Latency distribution",
  datasource: prometheus,
  targets: [latencyBuckets],
  options: heatmapCells,
});

const slowest = new TablePanel({ title: "Slow traces", datasource: tempo, targets: [slowTraces] });

const logView = { showTime: true, wrapLogMessage: true, sortOrder: "Descending" as const };
const logs = new LogsPanel({ title: "Logs", datasource: loki, targets: [serviceLogs], options: logView });

const trace = new TracesPanel({ title: "Trace $traceId", datasource: tempo, targets: [traceById] });

export { latencyDistribution, slowest, logs, trace };
