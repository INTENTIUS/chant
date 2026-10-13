/**
 * The datasources the alert rules query, provisioned with them so GRAF112
 * checks every rule query against them.
 */
import { Datasource } from "@intentius/chant-lexicon-grafana";

const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", uid: "prom", url: "http://prometheus:9090", isDefault: true });

const loki = new Datasource({ name: "Loki", type: "loki", uid: "loki", url: "http://loki:3100" });

export { prometheus, loki };
