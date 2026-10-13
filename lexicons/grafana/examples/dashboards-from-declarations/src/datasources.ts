/**
 * The datasources, as the Grafana container reaches them. Declared in the
 * same build root as the dashboards, so GRAF101 and GRAF102 check every
 * panel's reference against them.
 */
import { Datasource } from "@intentius/chant-lexicon-grafana";

const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090", isDefault: true });

const tempo = new Datasource({ name: "Tempo", type: "tempo", url: "http://tempo:3200" });

export { prometheus, tempo };
