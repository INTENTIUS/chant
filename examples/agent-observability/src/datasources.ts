/**
 * Grafana's datasources, as the Grafana pod reaches the backends in its own
 * namespace. Declared in the same build root as the dashboards, so GRAF101
 * and GRAF102 check every panel's datasource against them.
 */
import { Datasource } from "@intentius/chant-lexicon-grafana";

const prometheusDatasource = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus", isDefault: true });

const lokiDatasource = new Datasource({ name: "Loki", type: "loki", url: "http://loki:3100" });

// From a span to the logs of its trace, and a service graph from the span metrics.
const tracesToLogs = { datasourceUid: lokiDatasource, filterByTraceID: true, spanStartTimeShift: "-5m", spanEndTimeShift: "5m" };
const tempoSettings = { tracesToLogsV2: tracesToLogs, serviceMap: { datasourceUid: prometheusDatasource } };

const tempoDatasource = new Datasource({ name: "Tempo", type: "tempo", url: "http://tempo:3200", jsonData: tempoSettings });

export { prometheusDatasource, tempoDatasource, lokiDatasource };
