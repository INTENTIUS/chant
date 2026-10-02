import { Dashboard, Datasource, PromQuery, StatPanel, TimeSeriesPanel } from "@intentius/chant-lexicon-grafana";

export const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090" });

export const upQuery = new PromQuery({ expr: "sum(up)", instant: true });
export const rateQuery = new PromQuery({ expr: "sum(rate(http_requests_total[$__rate_interval]))" });

export const upPanel = new StatPanel({ title: "Targets up", datasource: prometheus, targets: [upQuery] });
export const ratePanel = new TimeSeriesPanel({ title: "Requests per second", datasource: prometheus, targets: [rateQuery] });

export const overview = new Dashboard({ title: "Smoke overview", uid: "smoke-overview", panels: [upPanel, ratePanel] });
