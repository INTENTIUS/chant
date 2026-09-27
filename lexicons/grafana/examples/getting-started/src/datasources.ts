/**
 * A service overview dashboard over Prometheus, Tempo and Loki, declared
 * once and built into dashboard JSON and Grafana's provisioning files.
 * This file: the three datasources, as the Grafana container reaches them.
 */
import { Datasource } from "@intentius/chant-lexicon-grafana";

const loki = new Datasource({ name: "Loki", type: "loki", url: "http://loki:3100" });

const prometheus = new Datasource({
  name: "Prometheus",
  type: "prometheus",
  url: "http://prometheus:9090",
  isDefault: true,
});

// Trace-to-logs: the declared Loki datasource is written as its uid.
const tracesToLogs = { datasourceUid: loki, filterByTraceID: true, spanStartTimeShift: "-5m", spanEndTimeShift: "5m" };
const tempoSettings = { tracesToLogsV2: tracesToLogs, serviceMap: { datasourceUid: prometheus } };

const tempo = new Datasource({ name: "Tempo", type: "tempo", url: "http://tempo:3200", jsonData: tempoSettings });

export { prometheus, tempo, loki };
