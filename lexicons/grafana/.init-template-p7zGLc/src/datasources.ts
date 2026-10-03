/**
 * The Prometheus the dashboard reads, one Grafana already has. It is checked
 * against (GRAF101, GRAF102) and never provisioned: set `uid` to its uid,
 * from Connections > Data sources in Grafana.
 */
import { ExternalDatasource } from "@intentius/chant-lexicon-grafana";

const prometheus = new ExternalDatasource({ type: "prometheus", uid: "prometheus", name: "Prometheus" });

export { prometheus };
