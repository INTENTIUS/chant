/**
 * Prometheus and Alertmanager as plain Kubernetes workloads, no operator and
 * no Helm, the way the prometheus lexicon's k3d-stack example runs them.
 * Each reads its config from a ConfigMap holding the files this build root's
 * prometheus entities serialize to, rendered with the same `ruleFileYaml` and
 * `alertmanagerYaml` the serializer uses, so the cluster runs exactly what
 * `chant build` writes.
 *
 * Prometheus finds the gateway replicas through the gateway's headless
 * Service, whose DNS name lists every ready pod, and scrapes the metrics
 * port of each.
 */
import { ConfiguredApp, type ConfiguredAppProps } from "@intentius/chant-lexicon-k8s";
import { alertmanagerYaml, ruleFileYaml } from "@intentius/chant-lexicon-prometheus";
import { agentRuns } from "./slo";
import { root, oncall, tickets, fallback, pageMutesTicket } from "./alertmanager";
import { METRICS_PORT } from "./gateway-components";
import { NAMESPACE } from "./namespace";

export const PROMETHEUS_IMAGE = "prom/prometheus:v3.15.0";
export const ALERTMANAGER_IMAGE = "prom/alertmanager:v0.34.1";

const gatewayReplicas = `otel-gateway-headless.${NAMESPACE}.svc.cluster.local`;

const prometheusYml = `global:
  scrape_interval: 15s
  evaluation_interval: 15s
rule_files:
  - /etc/prometheus/rules.yml
alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager:80"]
scrape_configs:
  - job_name: otel-gateway
    dns_sd_configs:
      - names: ["${gatewayReplicas}"]
        type: A
        port: ${METRICS_PORT}
        refresh_interval: 15s
  - job_name: prometheus
    static_configs:
      - targets: ["localhost:9090"]
`;

/** Both images run as nobody (65534) and need no capabilities. */
const securityContext: ConfiguredAppProps["securityContext"] = {
  runAsNonRoot: true,
  runAsUser: 65534,
  allowPrivilegeEscalation: false,
  capabilities: { drop: ["ALL"] },
};

const prometheus = ConfiguredApp({
  name: "prometheus",
  namespace: NAMESPACE,
  image: PROMETHEUS_IMAGE,
  port: 9090,
  replicas: 1,
  configData: { "prometheus.yml": prometheusYml, "rules.yml": ruleFileYaml([agentRuns.rules]) },
  configMountPath: "/etc/prometheus",
  memoryLimit: "512Mi",
  securityContext,
});

const alertmanager = ConfiguredApp({
  name: "alertmanager",
  namespace: NAMESPACE,
  image: ALERTMANAGER_IMAGE,
  port: 9093,
  replicas: 1,
  configData: { "alertmanager.yml": alertmanagerYaml([root, oncall, tickets, fallback, pageMutesTicket]) },
  configMountPath: "/etc/alertmanager",
  securityContext,
});

export { prometheus, alertmanager };
